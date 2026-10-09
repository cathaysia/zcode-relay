/**
 * 连接存活检测：relay 主动 ping。
 *
 * **为什么非要不做不行**：Deno 的 node:http 兼容层不上报升级连接上对端的
 * TCP FIN。实测（对端完成 WS 握手后直接关闭 socket，不给关闭帧）：
 * 3 秒内 server 侧 socket 既无 `end` 也无 `close`，`ws` 也不报错；只有下次
 * 往那条连接**写**东西才会由 RST/写失败把它带出来。于是"设备崩溃或断网"
 * 这类没有关闭帧的断开永远不会被发现——终端会一直停在 paired，
 * `DEVICE_OFFLINE` 与终端的 15 秒宽限期双双变成死代码。
 * Node 上没有这个差异，这是本次迁移引入的平台行为差异。
 *
 * **做法**：ws 官方推荐的 isAlive 模式。每个周期先把状态标成"待证明"并发一次
 * ping，收到 pong 才恢复；下一个周期仍未恢复就判定连接已死并 terminate，
 * 之后 `ws` 会走正常的 `close` 流程，`RelayCore.handleClose` 照常发出
 * `DEVICE_OFFLINE`。检测上界是两个周期。
 *
 * **两侧是否会受影响**：不会。协议明确写了 relay 可自由 ping、并且两侧
 * `ws` 客户端都会自动回 pong（docs/protocol.md §11）。
 */

import type { RelaySocket } from "./conn.ts";

/**
 * 默认 ping 周期。
 *
 * 取值口径：检测上界是 2×周期，要明显短于终端的 15 秒宽限期，否则"设备
 * 掉线—重连恢复"会变成必然的超时；同时要长于双方 8–12 秒的应用层心跳，
 * 免得把正常连接的 pong 挤到下一个周期。20 秒上界对这两种用途都够用。
 */
export const RELAY_PING_INTERVAL_MS = 10_000;

/**
 * 开始跟踪一条连接的存活；返回停止函数。
 *
 * `onDead` 只在判定死亡时调用一次——调用方通常直接 terminate，随后
 * 连接会走正常的 close 流程。
 */
export function startLiveness(
  socket: RelaySocket,
  intervalMs: number,
  onDead: () => void,
): () => void {
  let alive = true;
  let stopped = false;

  const timer = setInterval(() => {
    if (stopped) return;
    if (!alive) {
      onDead();
      return;
    }
    alive = false;
    try {
      socket.ping();
    } catch {
      // 已经写不出去：等同判定死亡
      onDead();
    }
  }, intervalMs);

  const stop = (): void => {
    if (stopped) return;
    stopped = true;
    clearInterval(timer);
  };

  socket.on("pong", () => {
    alive = true;
  });
  // 对端正常关闭、被 terminate、或写到死连接上出错，最终都会走到 close。
  socket.on("close", stop);

  return stop;
}
