/**
 * 连接抽象。把 WS 实现细节挡在核心逻辑之外，便于测试注入假连接。
 * 见 docs/design.md §6。
 *
 * 服务端跑在 Hono（`@hono/deno` 的 upgradeWebSocket，即 Deno 原生
 * WebSocket）上：`HonoWsConn` 包装的是 `WSContext`，只用 `send` / `close` /
 * `readyState` 三个成员。relay 核心与 Hono、Deno WS 都没有编译期之外的耦合。
 */

import type { Outbound } from "../protocol/messages.ts";
import { errorMessage, serializeOutbound } from "../protocol/messages.ts";
import type { RelayErrorCode } from "../protocol/limits.ts";
import { createConnId } from "../protocol/crypto.ts";

/** Hono WSContext 实际用到的最小结构子集（`send` / `close` / `readyState`）。 */
export interface HonoWs {
  readonly readyState: number;
  send(data: string | ArrayBuffer | Uint8Array): void;
  close(code?: number, reason?: string): void;
}

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

export interface HonoWsConnOptions {
  readonly ws: HonoWs;
  readonly queryMid: string | undefined;
  readonly deviceIdHeader: string | undefined;
  readonly tap?: FrameTap | undefined;
}

/**
 * WSContext 包装。`readyState === 1` 即 OPEN（见 hono/ws 的 WSReadyState）。
 *
 * 注意 Deno 原生 WS 没有 ping/terminate：存活检测不靠 relay 主动 ping，
 * 靠 Deno.serve 对 TCP 关闭的直接上报（见 docs/verification.md §L1）。
 * 超限帧也在应用层显式 close（1009），而不是靠 ws 库的 maxPayload。
 */
export class HonoWsConn implements Conn {
  readonly id: string = createConnId();
  readonly queryMid: string | undefined;
  readonly deviceIdHeader: string | undefined;

  readonly #ws: HonoWs;
  readonly #tap: FrameTap | undefined;

  constructor(options: HonoWsConnOptions) {
    this.#ws = options.ws;
    this.queryMid = options.queryMid;
    this.deviceIdHeader = options.deviceIdHeader;
    this.#tap = options.tap;
  }

  get isOpen(): boolean {
    return this.#ws.readyState === 1;
  }

  sendRaw(text: string): void {
    if (!this.isOpen) return;
    this.#tap?.onOutbound(this.id, text);
    this.#ws.send(text);
  }

  send(msg: Outbound): void {
    this.sendRaw(serializeOutbound(msg));
  }

  sendError(code: RelayErrorCode, message?: string): void {
    this.send(errorMessage(code, message));
  }

  close(): void {
    try {
      this.#ws.close();
    } catch {
      // 已关闭时忽略
    }
  }

  /** 超限帧：显式以 1009 关闭，对端看到 closed=true（此前由 ws 库的 maxPayload 承担）。 */
  closeForOversize(): void {
    try {
      this.#ws.close(1009, "message too large");
    } catch {
      // 已关闭时忽略
    }
  }
}
