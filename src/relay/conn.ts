/**
 * 连接抽象。把 ws 实现细节挡在核心逻辑之外，便于测试注入假连接。
 * 见 docs/design.md §6。
 */

import type { WebSocket } from "ws";
import type { Outbound } from "../protocol/messages.ts";
import { errorMessage, serializeOutbound } from "../protocol/messages.ts";
import type { RelayErrorCode } from "../protocol/limits.ts";
import { createConnId } from "../protocol/crypto.ts";

/** 帧观测点。用于 echo-relay 之类需要看到双向原始报文的地方，不参与协议语义。 */
export interface FrameTap {
  onInbound(connId: string, text: string): void;
  onOutbound(connId: string, text: string): void;
}

export interface Conn {
  /** 仅用于日志的短标识。 */
  readonly id: string;
  /** 查询参数 ?mid= 的值（设备总是带，终端可选）。 */
  readonly queryMid: string | undefined;
  /** 请求头 X-Device-ID（仅设备会带）。 */
  readonly deviceIdHeader: string | undefined;
  /** 逐字节转发用。调用方保证长度已在入站时校验。 */
  sendRaw(text: string): void;
  send(msg: Outbound): void;
  sendError(code: RelayErrorCode, message?: string): void;
  close(): void;
}

export interface WsConnOptions {
  readonly socket: WebSocket;
  readonly queryMid: string | undefined;
  readonly deviceIdHeader: string | undefined;
  readonly tap?: FrameTap | undefined;
}

export class WsConn implements Conn {
  readonly id: string = createConnId();
  readonly queryMid: string | undefined;
  readonly deviceIdHeader: string | undefined;

  readonly #socket: WebSocket;
  readonly #tap: FrameTap | undefined;

  constructor(options: WsConnOptions) {
    this.#socket = options.socket;
    this.queryMid = options.queryMid;
    this.deviceIdHeader = options.deviceIdHeader;
    this.#tap = options.tap;
  }

  sendRaw(text: string): void {
    if (this.#socket.readyState !== this.#socket.OPEN) return;
    this.#tap?.onOutbound(this.id, text);
    this.#socket.send(text);
  }

  send(msg: Outbound): void {
    this.sendRaw(serializeOutbound(msg));
  }

  sendError(code: RelayErrorCode, message?: string): void {
    this.send(errorMessage(code, message));
  }

  close(): void {
    this.#socket.close();
  }
}
