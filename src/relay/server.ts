/**
 * WS 接入层（独立模式）：relay 自己监听一个端口，只服务 WebSocket。
 *
 * 若要与 SPA 资源同端口部署，用 src/serve/main.ts —— 它把同一套
 * `registerRelayRoutes` 注册到资源共享的那个 Hono 实例上。
 */

import { Hono } from "hono";

import { type Logger, RelayCore } from "./relay.ts";
import { registerRelayRoutes } from "./routes.ts";
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

export interface RelayAddress {
  readonly address: string;
  readonly port: number;
}

export interface RelayServer {
  /** Hono 应用：测试经 `app.request()` 直接驱动 HTTP 断言；WS 走真实端口。 */
  readonly app: Hono;
  readonly core: RelayCore;
  readonly address: RelayAddress;
  close(): Promise<void>;
}

export function buildRelayApp(options: RelayServerOptions, core: RelayCore): Hono {
  const log = options.logger ?? NOOP_LOGGER;
  const app = new Hono();
  registerRelayRoutes(app, {
    path: options.path,
    core,
    logger: log,
    tap: options.tap,
  });
  return app;
}

/** 起一个只服务 WebSocket 的 relay；port 传 0 可让系统分配。 */
export function startRelayServer(options: RelayServerOptions): Promise<RelayServer> {
  const core = new RelayCore(options.logger ?? NOOP_LOGGER);
  const app = buildRelayApp(options, core);
  const server = Deno.serve(
    { hostname: options.host, port: options.port, onListen: () => {} },
    app.fetch,
  );
  const addr = server.addr as Deno.NetAddr;

  return Promise.resolve({
    app,
    core,
    address: { address: addr.hostname, port: addr.port },
    close: async () => {
      await server.shutdown();
    },
  });
}
