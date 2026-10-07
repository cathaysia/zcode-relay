/**
 * WS 接入层（独立模式）：relay 自己监听一个端口，只服务 WebSocket。
 *
 * 若要与 SPA 资源同端口部署，用 src/serve/main.ts，它复用
 * src/relay/accept.ts 的接线逻辑但把 HTTP 交给资源处理器。
 */

import { WebSocketServer } from "ws";
import type { AddressInfo } from "node:net";

import { RelayCore, type Logger } from "./relay.ts";
import { acceptConnections, WS_MAX_PAYLOAD } from "./accept.ts";
import type { FrameTap } from "./conn.ts";

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

export class RelayServer {
  readonly #core: RelayCore;
  readonly #wss: WebSocketServer;

  constructor(options: RelayServerOptions) {
    const log = options.logger ?? NOOP_LOGGER;
    this.#core = new RelayCore(log);
    this.#wss = new WebSocketServer({
      host: options.host,
      port: options.port,
      path: options.path,
      // 与协议上限一致：超限帧在 ws 层就被拒绝，避免无界缓冲。
      // 合规客户端发送前会自行检查上限，故不会触发。
      maxPayload: WS_MAX_PAYLOAD,
      // 接受 permessage-deflate；拒绝亦可，两端都容忍。
      perMessageDeflate: true,
    });
    acceptConnections(this.#wss, this.#core, log, options.tap);
  }

  get core(): RelayCore {
    return this.#core;
  }

  async listen(): Promise<AddressInfo> {
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
}
