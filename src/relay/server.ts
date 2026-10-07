/**
 * WS 接入层。见 docs/protocol.md §1 与 §10.1–§10.4。
 *
 * 职责边界：只做传输层的事（升级、解码、保序、上限），不含任何协议语义。
 * 因此这一层可以整体替换而不影响 RelayCore。
 */

import { WebSocketServer, type RawData } from "ws";
import type { IncomingMessage } from "node:http";
import type { AddressInfo } from "node:net";
import { RelayCore, type Logger } from "./relay.ts";
import { WsConn, type FrameTap } from "./conn.ts";
import { MAX_PHYSICAL_FRAME_BYTES } from "../protocol/limits.ts";

const NOOP_LOGGER: Logger = { info: () => {}, warn: () => {} };

export interface RelayServerOptions {
  readonly host: string;
  readonly port: number;
  /** 升级路径。设备连接的是我们配置的 relayWsUrl，故路径由我们决定。 */
  readonly path: string;
  readonly logger?: Logger;
  /** 帧观测点，用于调试与协议核对。不参与协议语义。 */
  readonly tap?: FrameTap | undefined;
}

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

export class RelayServer {
  readonly #core: RelayCore;
  readonly #wss: WebSocketServer;
  readonly #log: Logger;
  readonly #tap: FrameTap | undefined;

  constructor(options: RelayServerOptions) {
    this.#log = options.logger ?? NOOP_LOGGER;
    this.#tap = options.tap;
    this.#core = new RelayCore(this.#log);
    this.#wss = new WebSocketServer({
      host: options.host,
      port: options.port,
      path: options.path,
      // 与协议上限一致：超限帧在 ws 层就被拒绝，避免无界缓冲。
      // 合规客户端发送前会自行检查上限，故不会触发。
      maxPayload: MAX_PHYSICAL_FRAME_BYTES,
      // 接受 permessage-deflate；拒绝亦可，两端都容忍。
      perMessageDeflate: true,
    });
  }

  get core(): RelayCore {
    return this.#core;
  }

  async listen(): Promise<AddressInfo> {
    this.#wss.on("connection", (socket, request: IncomingMessage) => {
      this.#onConnection(socket, request);
    });
    await new Promise<void>((resolve, reject) => {
      this.#wss.once("listening", resolve);
      this.#wss.once("error", reject);
    });
    const address = this.#wss.address();
    if (address === null || typeof address === "string") {
      throw new Error("relay server has no TCP address");
    }
    return address;
  }

  async close(): Promise<void> {
    for (const client of this.#wss.clients) client.terminate();
    await new Promise<void>((resolve) => this.#wss.close(() => resolve()));
  }

  #onConnection(socket: import("ws").WebSocket, request: IncomingMessage): void {
    const rawUrl = request.url ?? "/";
    let mid: string | undefined;
    try {
      mid = new URL(rawUrl, "http://relay.invalid").searchParams.get("mid") ?? undefined;
    } catch {
      mid = undefined;
    }
    const connOptions =
      this.#tap === undefined
        ? { socket, queryMid: mid, deviceIdHeader: headerValue(request.headers["x-device-id"]) }
        : {
            socket,
            queryMid: mid,
            deviceIdHeader: headerValue(request.headers["x-device-id"]),
            tap: this.#tap,
          };
    const conn = new WsConn(connOptions);

    this.#core.handleConnect(conn);

    socket.on("message", (data: RawData) => {
      const text = decodeFrame(data);
      if (text === null) {
        this.#log.warn("drop undecodable frame", { conn: conn.id });
        return;
      }
      this.#tap?.onInbound(conn.id, text);
      this.#core.handleMessage(conn, text);
    });

    socket.on("close", () => {
      this.#core.handleClose(conn);
    });

    socket.on("error", (err: Error) => {
      this.#log.warn("socket error", { conn: conn.id, error: err.message });
    });
  }
}
