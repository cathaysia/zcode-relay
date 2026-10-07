/**
 * 单端口部署入口：同一个 HTTP server 同时提供 SPA 资源与 relay WebSocket。
 *
 * 为什么要同端口同源：SPA 是 https 页面，若 relay 走 ws:// 会被混合内容策略
 * 拦截；同端口部署只需一张证书、一个端口，也避免跨源配置。
 *
 * 环境变量：
 *   ZCODE_ASSETS_DIR      抓取并 patch 后的资源目录（必填）
 *   ZCODE_PUBLIC_ORIGIN   对外地址，如 https://zcode.internal（用于推导 wss 地址）
 *   ZCODE_RELAY_HOST      监听地址（默认 127.0.0.1，部署时设为 VPN 接口）
 *   ZCODE_RELAY_PORT      监听端口（默认 8899）
 *   ZCODE_RELAY_PATH      WebSocket 路径（默认 /ws）
 */

import { createServer } from "node:http";
import { stat } from "node:fs/promises";
import { join } from "node:path";
import { WebSocketServer } from "ws";

import { AssetServer } from "../assets/server.ts";
import { RelayCore, type Logger } from "../relay/relay.ts";
import { acceptConnections, WS_MAX_PAYLOAD } from "../relay/accept.ts";

const logger: Logger = {
  info(message, fields) {
    console.log(JSON.stringify({ ts: new Date().toISOString(), level: "info", message, ...fields }));
  },
  warn(message, fields) {
    console.warn(
      JSON.stringify({ ts: new Date().toISOString(), level: "warn", message, ...fields }),
    );
  },
};

function envString(name: string, fallback: string): string {
  const v = process.env[name]?.trim();
  return v !== undefined && v.length > 0 ? v : fallback;
}

const host = envString("ZCODE_RELAY_HOST", "127.0.0.1");
const port = Number(envString("ZCODE_RELAY_PORT", "8899"));
const wsPath = envString("ZCODE_RELAY_PATH", "/ws");
const assetsDir = process.env["ZCODE_ASSETS_DIR"]?.trim();
// 空字符串等同于未设置，否则会推导出空地址
const publicOrigin = envString("ZCODE_PUBLIC_ORIGIN", "") || undefined;

if (assetsDir === undefined || assetsDir.length === 0) {
  console.error("必须设置 ZCODE_ASSETS_DIR 指向抓取并 patch 后的资源目录。");
  console.error("先用 just fetch-assets 获取资源。");
  process.exit(2);
}
if (!Number.isInteger(port) || port <= 0 || port > 65535) {
  console.error(`ZCODE_RELAY_PORT 必须是 1..65535 的整数，收到 ${String(port)}`);
  process.exit(2);
}

// 未提供对外地址时，按监听地址推导（仅适用于本机访问）
const derivedOrigin = publicOrigin ?? `http://${host === "0.0.0.0" ? "127.0.0.1" : host}:${port}`;
const relayUrl = `${derivedOrigin.replace(/^http/, "ws")}${wsPath}`;

// 资源目录自检：缺 index.html 时明确告知，而不是等浏览器报错
let hasShell = true;
try {
  const info = await stat(join(assetsDir, "index.html"));
  hasShell = info.isFile();
} catch {
  hasShell = false;
}

const assets = new AssetServer({ rootDir: assetsDir, relayUrl, logger });
const core = new RelayCore(logger);

const httpServer = createServer(assets.handler());
const wss = new WebSocketServer({
  server: httpServer,
  path: wsPath,
  maxPayload: WS_MAX_PAYLOAD,
  perMessageDeflate: true,
});
acceptConnections(wss, core, logger, undefined);

await new Promise<void>((resolve, reject) => {
  httpServer.once("error", reject);
  httpServer.listen(port, host, resolve);
});

// ---- 启动报告 ----

const line = "=".repeat(78);
console.log(line);
console.log("zcode-relay  单端口部署");
console.log(line);
console.log(`监听        ${host}:${port}`);
console.log(`WebSocket   ${wsPath}`);
console.log(`资源目录    ${assetsDir}`);
console.log("");

if (!hasShell) {
  console.log("!! 资源目录里没有 index.html —— SPA 尚未抓取。");
  console.log("   现在只有 relay 可用。先执行：");
  console.log("     just fetch-assets <输出目录>");
  console.log("   再把 index.js patch 一次（见 docs/patching.md §2）。");
  console.log("");
}

console.log("-".repeat(78));
console.log("第 1 步：让桌面端连到这里");
console.log("-".repeat(78));
console.log("编辑 ~/.local/share/applications/zcode.desktop，把 Exec 改为：");
console.log("");
console.log("  Exec=env \\");
console.log(`    ZCODE_WEB_REMOTE_CONTROL_RELAY_WS_URL=${relayUrl} \\`);
console.log(`    ZCODE_WEB_REMOTE_CONTROL_URL=${derivedOrigin}/remote/v4 \\`);
console.log("    /opt/ZCode/zcode %U");
console.log("");
console.log("重启 ZCode 后，在界面里开启「Web 远程控制」。");
console.log(`此时二维码指向的是自托管地址（${derivedOrigin}/remote/v4）。`);
console.log("");

console.log("-".repeat(78));
console.log("第 2 步：在手机/浏览器打开");
console.log("-".repeat(78));
console.log("直接扫桌面端显示的二维码即可。等价的手工地址：");
console.log("");
console.log(`  ${derivedOrigin}/remote/v4?sid=<device_sid>&hash=<pass_hash>&t=<ts>`);
console.log("");
console.log("relay 地址由服务端注入外壳的 meta 标签，无需手改 HTML：");
console.log(`  <meta name="zcode-relay-ws" content="${relayUrl}">`);
console.log("");
console.log("-".repeat(78));
console.log("自检");
console.log("-".repeat(78));
console.log(`  状态页   ${derivedOrigin}/`);
console.log(`  资源     curl -I ${derivedOrigin}/remote/v4/latest/`);
console.log(`  端口     ss -tlnp | grep ${String(port)}`);
console.log(line);

if (host === "0.0.0.0" || host === "::") {
  logger.warn(
    "绑定到全部接口：pass_hash 会暴露给该网络的所有可达主机。建议限定 VPN 接口。",
    { host },
  );
}

let shuttingDown = false;
for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info("shutting down", { signal });
    for (const client of wss.clients) client.terminate();
    httpServer.close(() => process.exit(0));
  });
}
