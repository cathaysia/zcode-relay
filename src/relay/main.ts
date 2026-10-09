/**
 * Relay 入口。
 *
 * 环境变量：
 *   ZCODE_RELAY_HOST  监听地址（默认 127.0.0.1；部署时应设为 VPN 接口地址）
 *   ZCODE_RELAY_PORT  监听端口（默认 18899）
 *   ZCODE_RELAY_PATH  WS 升级路径（默认 /ws）
 *
 * 安全提醒：relay 在内存中持有 pass_hash（见 docs/design.md §S5）。
 * 监听地址务必限定在 VPN 接口，不要绑 0.0.0.0。
 */

import { startRelayServer } from "./server.ts";
import type { Logger } from "./relay.ts";

const logger: Logger = {
  info(message, fields) {
    console.log(
      JSON.stringify({ ts: new Date().toISOString(), level: "info", message, ...fields }),
    );
  },
  warn(message, fields) {
    console.warn(
      JSON.stringify({ ts: new Date().toISOString(), level: "warn", message, ...fields }),
    );
  },
};

function envString(name: string, fallback: string): string {
  const value = Deno.env.get(name)?.trim();
  return value !== undefined && value.length > 0 ? value : fallback;
}

function envPort(name: string, fallback: number): number {
  const raw = Deno.env.get(name)?.trim();
  if (raw === undefined || raw.length === 0) return fallback;
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed <= 0 || parsed > 65535) {
    throw new Error(`${name} 必须是 1..65535 的整数，收到 ${raw}`);
  }
  return parsed;
}

const host = envString("ZCODE_RELAY_HOST", "127.0.0.1");
const port = envPort("ZCODE_RELAY_PORT", 18899);
const path = envString("ZCODE_RELAY_PATH", "/ws");

if (host === "0.0.0.0" || host === "::") {
  logger.warn("relay 绑定到全部接口，pass_hash 将暴露给该网络的所有可达主机；建议限定 VPN 接口", {
    host,
  });
}

const server = await startRelayServer({ host, port, path, logger });
const { address } = server;

logger.info("relay listening", { host: address.address, port: address.port, path });
logger.info("设备端配置", {
  ZCODE_WEB_REMOTE_CONTROL_RELAY_WS_URL: `wss://<你的域名或地址>:${address.port}${path}`,
});

let shuttingDown = false;
for (const signal of ["SIGINT", "SIGTERM"] as const) {
  Deno.addSignalListener(signal, () => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info("shutting down", { signal });
    void server.close().then(() => Deno.exit(0));
  });
}
