/**
 * WS 接入层（独立模式）：relay 自己监听一个端口，只服务 WebSocket。
 *
 * 若要与 SPA 资源同端口部署，用 src/serve/main.ts —— 它把同一套
 * `registerRelayRoutes` 注册到资源共享的那个 Fastify 实例上。
 */

import fastify from "fastify";

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
  /** relay 主动 ping 的周期，见 routes.ts 与 liveness.ts。 */
  readonly livenessIntervalMs?: number | undefined;
}

export interface RelayAddress {
  readonly address: string;
  readonly port: number;
}

export interface RelayServer {
  /** 供测试注入或直接驱动（app.inject）使用。 */
  readonly app: Awaited<ReturnType<typeof buildRelayApp>>;
  readonly core: RelayCore;
  readonly address: RelayAddress;
  close(): Promise<void>;
}

async function buildRelayApp(
  options: RelayServerOptions,
  core: RelayCore,
): Promise<fastify.FastifyInstance> {
  const log = options.logger ?? NOOP_LOGGER;
  const app = fastify({
    logger: false,
    // 关服务时连保活连接一起收掉，否则 close 要等对端先走。
    forceCloseConnections: true,
  });
  await registerRelayRoutes(app, {
    path: options.path,
    core,
    logger: log,
    tap: options.tap,
    livenessIntervalMs: options.livenessIntervalMs,
  });
  return app;
}

/** 起一个只服务 WebSocket 的 relay；port 传 0 可让系统分配。 */
export async function startRelayServer(options: RelayServerOptions): Promise<RelayServer> {
  const core = new RelayCore(options.logger ?? NOOP_LOGGER);
  const app = await buildRelayApp(options, core);
  await app.listen({ host: options.host, port: options.port });

  const bound = app.server.address();
  if (bound === null || typeof bound === "string") {
    throw new Error("relay server has no TCP address");
  }

  return {
    app,
    core,
    address: { address: bound.address, port: bound.port },
    close: async () => {
      await app.close();
    },
  };
}
