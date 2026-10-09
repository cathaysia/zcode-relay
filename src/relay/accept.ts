/**
 * WS 连接接线：把一条已建立的 socket 接到 RelayCore 上。
 * 见 docs/protocol.md §1 与 §10.1–§10.4。
 *
 * 这一段刻意不含框架代码：Fastify 的 route 注册在 src/relay/routes.ts，
 * 独立监听在 src/relay/server.ts。于是同一份接线既能挂在单端口服务上，
 * 也能被单元测试直接驱动。
 */

import { type Conn, type FrameTap, type RelaySocket, WsConn } from "./conn.ts";
import { startLiveness } from "./liveness.ts";
import type { Logger, RelayCore } from "./relay.ts";
import { utf8ByteLength } from "../protocol/messages.ts";

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
  /** relay 主动 ping 的周期。见 liveness.ts 的说明。 */
  readonly livenessIntervalMs: number;
}

const UTF8_DECODER = new TextDecoder("utf-8");

/**
 * 把 ws 的 message 载荷解码为文本。
 * 文本帧是规范形式；二进制帧被容忍（对端两侧都容忍），按 UTF-8 解码后
 * 以文本形式转发——这样下游看到的形态是统一的。
 */
function decodeText(data: unknown): string | null {
  try {
    if (typeof data === "string") return data;
    if (data instanceof Uint8Array) return UTF8_DECODER.decode(data);
    if (data instanceof ArrayBuffer) return UTF8_DECODER.decode(new Uint8Array(data));
    if (Array.isArray(data)) {
      const chunks = data.filter((chunk): chunk is Uint8Array => chunk instanceof Uint8Array);
      if (chunks.length === 0 || chunks.length !== data.length) return null;
      const joined = new Uint8Array(chunks.reduce((total, chunk) => total + chunk.byteLength, 0));
      let offset = 0;
      for (const chunk of chunks) {
        joined.set(chunk, offset);
        offset += chunk.byteLength;
      }
      return UTF8_DECODER.decode(joined);
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * 帧在线上占多少字节。取**收到时的原始字节数**，而不是解码后再编码的长度：
 * 上限判定的对象是线上帧。已知时不必为一个 MiB 级的字符串再编码一遍。
 */
function frameBytes(data: unknown, text: string): number {
  if (typeof data === "string") return utf8ByteLength(data);
  if (data instanceof Uint8Array || data instanceof ArrayBuffer) return data.byteLength;
  if (Array.isArray(data)) {
    return data.reduce(
      (total, chunk) => total + (chunk instanceof Uint8Array ? chunk.byteLength : 0),
      0,
    );
  }
  return utf8ByteLength(text);
}

/** 为一个已建立的 WS 连接接上协议处理与存活检测。 */
export function attachConnection(socket: RelaySocket, options: AttachOptions): Conn {
  const { info, core, log, tap } = options;
  const conn = new WsConn(
    tap === undefined
      ? { socket, queryMid: info.queryMid, deviceIdHeader: info.deviceIdHeader }
      : { socket, queryMid: info.queryMid, deviceIdHeader: info.deviceIdHeader, tap },
  );

  core.handleConnect(conn);

  // 没有这一步，对端发 FIN 而不给关闭帧时连接会永远"活着"（见 liveness.ts）。
  startLiveness(socket, options.livenessIntervalMs, () => {
    log.warn("connection unresponsive to ping, terminating", { conn: conn.id });
    socket.terminate();
  });

  socket.on("message", (data: unknown) => {
    const text = decodeText(data);
    if (text === null) {
      log.warn("drop undecodable frame", { conn: conn.id });
      return;
    }
    tap?.onInbound(conn.id, text);
    // 不 await：data 转发在 handleMessage 内部是同步跑完的（见 RelayCore），
    // 只有认证路径会挂起，而那条路径按连接串行化。
    void core.handleMessage(conn, text, frameBytes(data, text));
  });

  socket.on("close", () => {
    core.handleClose(conn);
  });

  socket.on("error", (err: Error) => {
    log.warn("socket error", { conn: conn.id, error: err.message });
  });

  return conn;
}
