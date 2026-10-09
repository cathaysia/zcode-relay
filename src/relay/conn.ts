/**
 * 连接抽象。把 ws 实现细节挡在核心逻辑之外，便于测试注入假连接。
 * 见 docs/design.md §6。
 *
 * 这里连 `ws` 的类型都不引用：@fastify/websocket 交来的 socket **结构上**
 * 满足 RelaySocket，故 relay 核心与 ws、Fastify 都没有编译期耦合。
 */

import type { Outbound } from "../protocol/messages.ts";
import { errorMessage, serializeOutbound } from "../protocol/messages.ts";
import type { RelayErrorCode } from "../protocol/limits.ts";
import { createConnId } from "../protocol/crypto.ts";

/** 帧观测点。用于 echo-relay 之类需要看到双向原始报文的地方，不参与协议语义。 */
export interface FrameTap {
  onInbound(connId: string, text: string): void;
  onOutbound(connId: string, text: string): void;
}

/** 够用的 WebSocket 子集；ws 的 WebSocket 实例可直接满足它。 */
export interface RelaySocket {
  readonly readyState: number;
  readonly OPEN: number;
  send(data: string): void;
  close(): void;
  /** 立即断开，不发关闭帧。存活检测判定连接已死时用它。 */
  terminate(): void;
  /** 发一个 ping。对端（浏览器或 ws 客户端）会自动回 pong。 */
  ping(): void;
  /** ws 的事件订阅。回调载荷按 unknown 接收，解码在 attachConnection 里做。 */
  on(event: "message", listener: (data: unknown) => void): unknown;
  on(event: "close", listener: () => void): unknown;
  on(event: "error", listener: (error: Error) => void): unknown;
  on(event: "pong", listener: () => void): unknown;
}

export interface Conn {
  /** 仅用于日志的短标识。 */
  readonly id: string;
  /** 查询参数 ?mid= 的值（设备总是带，终端可选）。 */
  readonly queryMid: string | undefined;
  /** 请求头 X-Device-ID（仅设备会带）。 */
  readonly deviceIdHeader: string | undefined;
  /**
   * 底层 socket 是否仍然可写。
   *
   * 认证校验是异步的（Web Crypto 无同步 HMAC），校验期间对端可能已经断开；
   * 读到这里为 false 时，认证路径会拒绝附着一条已死的连接。
   */
  readonly isOpen: boolean;
  /** 逐字节转发用。调用方保证长度已在入站时校验。 */
  sendRaw(text: string): void;
  send(msg: Outbound): void;
  sendError(code: RelayErrorCode, message?: string): void;
  close(): void;
}

export interface WsConnOptions {
  readonly socket: RelaySocket;
  readonly queryMid: string | undefined;
  readonly deviceIdHeader: string | undefined;
  readonly tap?: FrameTap | undefined;
}

export class WsConn implements Conn {
  readonly id: string = createConnId();
  readonly queryMid: string | undefined;
  readonly deviceIdHeader: string | undefined;

  readonly #socket: RelaySocket;
  readonly #tap: FrameTap | undefined;

  constructor(options: WsConnOptions) {
    this.#socket = options.socket;
    this.queryMid = options.queryMid;
    this.deviceIdHeader = options.deviceIdHeader;
    this.#tap = options.tap;
  }

  get isOpen(): boolean {
    return this.#socket.readyState === this.#socket.OPEN;
  }

  sendRaw(text: string): void {
    if (!this.isOpen) return;
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
