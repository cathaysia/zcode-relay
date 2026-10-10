/**
 * WS 连接接线：把一条已建立的 Hono WSContext 接到 RelayCore 上。
 * 见 docs/protocol.md §1 与 §10.1–§10.4。
 *
 * 这一段刻意不含框架路由代码：Hono 的路由注册在 src/relay/routes.ts，
 * 独立监听在 src/relay/server.ts。于是同一份接线既能挂在单端口服务上，
 * 也能被单元测试直接驱动（经 FakeConn）。
 *
 * 与迁移前的差异（Fastify + `ws` → Hono + Deno 原生 WS）：
 *   - 入站载荷是 unknown（string | Blob | ArrayBufferLike），
 *     二进制按 UTF-8 解码后以文本形式转发——下游看到的形态是统一的。
 *     Deno 默认 binaryType 是 arraybuffer，故 Blob 分支只是兜底。
 *   - 帧长度按线上字节数判定；超限时显式 close(1009) 而不是靠 ws 库的
 *     maxPayload（原生 WS 没有该选项）。合规客户端发送前会自行检查上限，
 *     故不会触发。
 *   - 存活检测不靠 relay 主动 ping：Deno.serve 直接上报 TCP 关闭，
 *     不存在 node:http 兼容层丢 FIN 的问题（见 docs/verification.md §L1）。
 */

import { type Conn, type FrameTap, type HonoWs, HonoWsConn } from "./conn.ts";
import type { Logger, RelayCore } from "./relay.ts";
import { utf8ByteLength } from "../protocol/messages.ts";
import { MAX_PHYSICAL_FRAME_BYTES } from "../protocol/limits.ts";

/** 建立连接时从 HTTP 升级请求里取到的两条信息。 */
export interface ConnectionInfo {
  /** 查询参数 ?mid=。取不到不影响协议。 */
  readonly queryMid: string | undefined;
  /** 请求头 X-Device-ID（仅设备会带）。 */
  readonly deviceIdHeader: string | undefined;
}

export interface AttachOptions {
  readonly info: ConnectionInfo;
  readonly core: RelayCore;
  readonly log: Logger;
  readonly tap: FrameTap | undefined;
}

const UTF8_DECODER = new TextDecoder("utf-8");

/**
 * 把入站载荷解码为文本。
 * 文本帧是规范形式；二进制帧被容忍（对端两侧都容忍）。
 */
async function decodeText(data: unknown): Promise<string | null> {
  try {
    if (typeof data === "string") return data;
    if (data instanceof Uint8Array) return UTF8_DECODER.decode(data);
    if (data instanceof ArrayBuffer) return UTF8_DECODER.decode(new Uint8Array(data));
    if (typeof Blob !== "undefined" && data instanceof Blob) {
      return UTF8_DECODER.decode(new Uint8Array(await data.arrayBuffer()));
    }
    return null;
  } catch {
    return null;
  }
}

/** 帧在线上占多少字节：上限判定的对象是线上帧。 */
function frameBytesOf(text: string): number {
  return utf8ByteLength(text);
}

/**
 * 为一个已建立的 WS 连接接上协议处理。返回 Conn 与事件回调，
 * 由 routes.ts 的 upgradeWebSocket 事件直接调用。
 */
export function createAttachedConn(
  ws: HonoWs,
  options: AttachOptions,
): { conn: Conn; onMessage: (data: unknown) => void; onClose: () => void } {
  const { info, core, log, tap } = options;
  const conn: Conn = new HonoWsConn(
    tap === undefined
      ? { ws, queryMid: info.queryMid, deviceIdHeader: info.deviceIdHeader }
      : { ws, queryMid: info.queryMid, deviceIdHeader: info.deviceIdHeader, tap },
  );

  core.handleConnect(conn);

  const onMessage = (data: unknown): void => {
    void (async () => {
      const text = await decodeText(data);
      if (text === null) {
        log.warn("drop undecodable frame", { conn: conn.id });
        return;
      }
      if (frameBytesOf(text) > MAX_PHYSICAL_FRAME_BYTES) {
        log.warn("oversize frame, closing", { conn: conn.id });
        if (conn instanceof HonoWsConn) conn.closeForOversize();
        else conn.close();
        return;
      }
      tap?.onInbound(conn.id, text);
      // 不 await：data 转发在 handleMessage 内部是同步跑完的（见 RelayCore），
      // 只有认证路径会挂起，而那条路径按连接串行化。
      // 传 frameBytes 避免对 MiB 级字符串再编码一遍量长度。
      void core.handleMessage(conn, text, frameBytesOf(text));
    })();
  };

  const onClose = (): void => {
    core.handleClose(conn);
  };

  return { conn, onMessage, onClose };
}
