/**
 * WS 连接接线。抽出成独立函数，使 relay 既能自己监听（独立模式），
 * 也能挂到别的 HTTP server 上（与资源托管同端口模式）。
 * 见 docs/protocol.md §1 与 §10.1–§10.4。
 */

import type { IncomingMessage } from "node:http";
import type { RawData, WebSocket, WebSocketServer } from "ws";

import { WsConn, type Conn, type FrameTap } from "./conn.ts";
import type { Logger, RelayCore } from "./relay.ts";
import { MAX_PHYSICAL_FRAME_BYTES } from "../protocol/limits.ts";

/** 从请求头取单值字符串。 */
function headerValue(v: string | string[] | undefined): string | undefined {
  if (v === undefined) return undefined;
  return Array.isArray(v) ? v[0] : v;
}

/**
 * 把 ws 的 RawData 解码为文本。
 * 文本帧是规范形式；二进制帧被容忍（对端两侧都容忍），按 UTF-8 解码后
 * 以文本形式转发——这样下游看到的形态是统一的。
 */
function decodeFrame(data: RawData): string | null {
  try {
    if (typeof data === "string") return data;
    if (Array.isArray(data)) return Buffer.concat(data).toString("utf8");
    if (Buffer.isBuffer(data)) return data.toString("utf8");
    return Buffer.from(data as ArrayBuffer).toString("utf8");
  } catch {
    return null;
  }
}

/** 从升级请求里取 ?mid=。取不到不影响协议。 */
function queryMid(request: IncomingMessage): string | undefined {
  try {
    const url = new URL(request.url ?? "/", "http://relay.invalid");
    return url.searchParams.get("mid") ?? undefined;
  } catch {
    return undefined;
  }
}

/** 为一个已建立的 WS 连接接上协议处理。 */
export function attachConnection(
  socket: WebSocket,
  request: IncomingMessage,
  core: RelayCore,
  log: Logger,
  tap: FrameTap | undefined,
): Conn {
  const deviceId = headerValue(request.headers["x-device-id"]);
  const conn = new WsConn(
    tap === undefined
      ? { socket, queryMid: queryMid(request), deviceIdHeader: deviceId }
      : { socket, queryMid: queryMid(request), deviceIdHeader: deviceId, tap },
  );

  core.handleConnect(conn);

  socket.on("message", (data: RawData) => {
    const text = decodeFrame(data);
    if (text === null) {
      log.warn("drop undecodable frame", { conn: conn.id });
      return;
    }
    tap?.onInbound(conn.id, text);
    core.handleMessage(conn, text);
  });

  socket.on("close", () => {
    core.handleClose(conn);
  });

  socket.on("error", (err: Error) => {
    log.warn("socket error", { conn: conn.id, error: err.message });
  });

  return conn;
}

/** 把整个 wss 的 connection 事件接到 core 上。 */
export function acceptConnections(
  wss: WebSocketServer,
  core: RelayCore,
  log: Logger,
  tap: FrameTap | undefined,
): void {
  wss.on("connection", (socket, request) => {
    attachConnection(socket, request, core, log, tap);
  });
}

/** ws 服务端应使用的最大载荷，与协议上限一致。 */
export const WS_MAX_PAYLOAD = MAX_PHYSICAL_FRAME_BYTES;
