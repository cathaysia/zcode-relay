/**
 * WS 接入层的 Fastify 接线：把 relay 挂到一个 Fastify 实例的路由上。
 *
 * 升级握手、帧边界、permessage-deflate、超限帧的拒绝都交给 @fastify/websocket
 * （它内部就是 ws），我们只负责把升级请求里的 ?mid= 与 X-Device-ID 取出来，
 * 再交给协议接线（src/relay/accept.ts）。见 docs/protocol.md §10.1–§10.4。
 */

import websocket from "@fastify/websocket";
import type { FastifyInstance, FastifyRequest } from "fastify";

import { attachConnection } from "./accept.ts";
import type { FrameTap } from "./conn.ts";
import { RELAY_PING_INTERVAL_MS } from "./liveness.ts";
import type { Logger, RelayCore } from "./relay.ts";
import { MAX_PHYSICAL_FRAME_BYTES } from "../protocol/limits.ts";

/**
 * ws 服务端应使用的最大载荷，与协议上限一致：超限帧在 ws 层就被拒绝，
 * 避免无界缓冲。合规客户端发送前会自行检查上限，故不会触发。
 */
export const WS_MAX_PAYLOAD = MAX_PHYSICAL_FRAME_BYTES;

/** 从请求头取单值字符串。 */
function headerValue(value: string | string[] | undefined): string | undefined {
  if (value === undefined) return undefined;
  return Array.isArray(value) ? value[0] : value;
}

/**
 * 从升级请求里取 ?mid=。取不到不影响协议。
 *
 * 这里走原始 URL 而不是 Fastify 的 request.query：mid 只用于日志，
 * 而原始 URL 的解析结果与迁移前逐字一致（空值也原样带出）。
 */
function queryMidOf(request: FastifyRequest): string | undefined {
  const rawUrl = request.raw.url ?? request.url ?? "/";
  try {
    return new URL(rawUrl, "http://relay.invalid").searchParams.get("mid") ?? undefined;
  } catch {
    return undefined;
  }
}

export interface RelayRoutesOptions {
  /** 升级路径。设备连接的是我们配置的 relayWsUrl，故路径由我们决定。 */
  readonly path: string;
  readonly core: RelayCore;
  readonly logger: Logger;
  /** 帧观测点，用于调试与协议核对。不参与协议语义。 */
  readonly tap?: FrameTap | undefined;
  /**
   * relay 主动 ping 的周期（默认 10 秒）。存活检测为什么必需见 liveness.ts；
   * 测试会调小它，好让"对端只发 FIN 时也能判死"在毫秒级内被验到。
   */
  readonly livenessIntervalMs?: number | undefined;
}

/** 在给定 Fastify 实例上注册 relay 的 WS 路由。 */
export async function registerRelayRoutes(
  app: FastifyInstance,
  options: RelayRoutesOptions,
): Promise<void> {
  const { core, logger, tap } = options;
  const livenessIntervalMs = options.livenessIntervalMs ?? RELAY_PING_INTERVAL_MS;

  await app.register(websocket, {
    options: {
      maxPayload: WS_MAX_PAYLOAD,
      // 接受 permessage-deflate；拒绝亦可，两端都容忍。
      perMessageDeflate: true,
    },
  });

  const live = new Set<{ terminate(): void }>();

  app.get(options.path, { websocket: true }, (socket, request) => {
    live.add(socket);
    socket.on("close", () => live.delete(socket));
    attachConnection(socket, {
      info: {
        queryMid: queryMidOf(request),
        deviceIdHeader: headerValue(request.headers["x-device-id"]),
      },
      core,
      log: logger,
      tap,
      livenessIntervalMs,
    });
  });

  // 关服务前必须主动断开活着的 WS：升级后的连接不属于 HTTP server 的
  // 常规连接，close 不会替我们收掉它们（迁移前的实现同样显式 terminate）。
  app.addHook("preClose", () => {
    for (const socket of live) socket.terminate();
    live.clear();
  });
}
