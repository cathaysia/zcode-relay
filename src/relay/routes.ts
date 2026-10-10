/**
 * WS 接入层的 Hono 接线：把 relay 挂到一个 Hono 实例的路由上。
 *
 * 升级握手与帧边界由 Deno 原生 WS（经 `@hono/deno` 的 upgradeWebSocket）
 * 承担；超限帧在应用层显式 close(1009)，permessage-deflate 由 Deno 决定
 * （接受或拒绝两端都容忍）。我们只负责把升级请求里的 ?mid= 与 X-Device-ID
 * 取出来，再交给协议接线（src/relay/accept.ts）。见 docs/protocol.md
 * §10.1–§10.4。
 */

import type { Hono } from "hono";
import { upgradeWebSocket } from "@hono/deno";

import { createAttachedConn } from "./accept.ts";
import type { FrameTap } from "./conn.ts";
import type { Logger, RelayCore } from "./relay.ts";
import { MAX_PHYSICAL_FRAME_BYTES } from "../protocol/limits.ts";

/**
 * WS 服务端接受的最大载荷，与协议上限一致。原生 WS 没有 maxPayload 选项，
 * 故在 accept.ts 的入站路径上显式判定并 close(1009)；导出此常量供文档与
 * 测试引用。合规客户端发送前会自行检查上限，故不会触发。
 */
export const WS_MAX_PAYLOAD = MAX_PHYSICAL_FRAME_BYTES;

export interface RelayRoutesOptions {
  /** 升级路径。设备连接的是我们配置的 relayWsUrl，故路径由我们决定。 */
  readonly path: string;
  readonly core: RelayCore;
  readonly logger: Logger;
  /** 帧观测点，用于调试与协议核对。不参与协议语义。 */
  readonly tap?: FrameTap | undefined;
}

/** 在给定 Hono 实例上注册 relay 的 WS 路由。 */
export function registerRelayRoutes(app: Hono, options: RelayRoutesOptions): void {
  const { core, logger, tap } = options;

  app.get(
    options.path,
    upgradeWebSocket((c) => {
      // mid 只用于日志，取不到不影响协议
      const info = {
        queryMid: c.req.query("mid"),
        deviceIdHeader: c.req.header("x-device-id"),
      };
      let attached: ReturnType<typeof createAttachedConn> | undefined;

      return {
        onOpen(_event, ws) {
          attached = createAttachedConn(ws, { info, core, log: logger, tap });
        },
        onMessage(event) {
          attached?.onMessage(event.data);
        },
        onClose() {
          attached?.onClose();
        },
        onError(event) {
          logger.warn("socket error", {
            error: event instanceof Error ? event.message : String(event),
          });
        },
      };
    }),
  );
}
