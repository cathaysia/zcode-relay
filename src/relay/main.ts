/**
 * Relay 入口。
 *
 * 环境变量：
 *   ZCODE_RELAY_HOST  监听地址（默认 127.0.0.1；部署时应设为 VPN 接口地址）
 *   ZCODE_RELAY_PORT  监听端口（默认 18899）
 *   ZCODE_RELAY_PATH  WS 升级路径（默认 /ws）
 *   ZCODE_LOG_LEVEL   日志级别（默认 INFO，见 src/logging.ts）
 *
 * 解析与校验见 src/env.ts：非法值在启动时直接报错退出。
 *
 * 安全提醒：relay 在内存中持有 pass_hash（见 docs/design.md §S5）。
 * 监听地址务必限定在 VPN 接口，不要绑 0.0.0.0。
 */

import { startRelayServer } from "./server.ts";
import { loadRelayEnvOrExit } from "../env.ts";
import { createLogger, setupLogging } from "../logging.ts";

const env = loadRelayEnvOrExit();
setupLogging(env.ZCODE_LOG_LEVEL);
const logger = createLogger();

const { ZCODE_RELAY_HOST: host, ZCODE_RELAY_PORT: port, ZCODE_RELAY_PATH: path } = env;

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
