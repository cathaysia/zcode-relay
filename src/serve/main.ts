/**
 * 单端口部署入口：一个 Hono 实例同时提供 SPA 资源与 relay WebSocket。
 *
 * 启动前会做预检并把 relay patch 套在**内存 overlay** 上：
 *   - 磁盘上的厂商资源保持原样（manifest.json 的 sha256 始终可校验）
 *   - 入口 bundle 的 patched 版本只在内存里，避免原地改写官方资源
 *   - 预检不通过则拒绝启动，避免静默送出未 patch 的 bundle
 *
 * 为什么要同端口同源：SPA 是 https 页面，若 relay 走 ws:// 会被混合内容策略
 * 拦截；同端口部署只需一张证书、一个端口，也避免跨源配置。
 *
 * 环境变量：
 *   ZCODE_ASSETS_DIR      抓取所得的厂商资源目录（必填）
 *   ZCODE_PUBLIC_ORIGIN   对外地址，如 https://zcode.internal（用于推导 wss 地址）
 *   ZCODE_RELAY_HOST      监听地址（默认 127.0.0.1，部署时设为 VPN 接口）
 *   ZCODE_RELAY_PORT      监听端口（默认 18899）
 *   ZCODE_RELAY_PATH      WebSocket 路径（默认 /ws）
 *   ZCODE_SERVE_NO_PATCH=1        关闭入口 patch（SPA 会连回厂商 relay）
 *   ZCODE_SERVE_ALLOW_UNPATCHED=1 预检失败时仍启动（仅供排查，不推荐）
 *   ZCODE_LOG_LEVEL   日志级别（默认 INFO，见 src/logging.ts）
 *
 * 解析与校验见 src/env.ts：非法值在启动时直接报错退出。
 */

import { Hono } from "hono";
import * as posix from "@std/path/posix";

import { AssetProvider, type PrepareReport } from "../assets/provider.ts";
import { registerAssetRoutes } from "../assets/routes.ts";
import { RelayCore } from "../relay/relay.ts";
import { registerRelayRoutes } from "../relay/routes.ts";
import { getPlatformConfigGuide } from "../platform.ts";
import { loadServeEnvOrExit } from "../env.ts";
import { createLogger, setupLogging } from "../logging.ts";

const env = loadServeEnvOrExit();
setupLogging(env.ZCODE_LOG_LEVEL);
const logger = createLogger();

const {
  ZCODE_RELAY_HOST: host,
  ZCODE_RELAY_PORT: port,
  ZCODE_RELAY_PATH: wsPath,
  ZCODE_ASSETS_DIR: assetsDir,
  ZCODE_PUBLIC_ORIGIN: publicOrigin,
  ZCODE_SERVE_NO_PATCH: noPatch,
  ZCODE_SERVE_ALLOW_UNPATCHED: allowUnpatched,
} = env;

const LINE = "=".repeat(78);
const THIN = "-".repeat(78);

// 资源目录自检：缺 index.html 时给出可执行的下一步
try {
  const info = await Deno.stat(posix.join(assetsDir, "index.html"));
  if (!info.isFile) throw new Error("not a file");
} catch {
  console.error(LINE);
  console.error(`资源目录里没有 index.html: ${assetsDir}`);
  console.error(LINE);
  console.error("先抓取资源（可先小批量验证）：");
  console.error("");
  console.error(`  just fetch-assets ${assetsDir} --limit 3`);
  console.error(`  just fetch-assets ${assetsDir}`);
  console.error("");
  console.error("抓取是幂等的，中断后重跑会跳过已抓文件。");
  Deno.exit(2);
}

const derivedOrigin = publicOrigin ?? `http://${host === "0.0.0.0" ? "127.0.0.1" : host}:${port}`;
const relayUrl = `${derivedOrigin.replace(/^http/, "ws")}${wsPath}`;

const assets = new AssetProvider({
  rootDir: assetsDir,
  relayUrl,
  patchEntryBundle: !noPatch,
  logger,
});

// ---- 预检：解析外壳、定位入口、套用 patch（内存 overlay）----
let report: PrepareReport;
try {
  report = await assets.prepare();
} catch (err) {
  const message = err instanceof Error ? err.message : String(err);
  console.error(`预检失败: ${message}`);
  Deno.exit(1);
}

console.log(LINE);
console.log("zcode-relay  单端口部署");
console.log(LINE);
console.log(`监听        ${host}:${port}`);
console.log(`WebSocket   ${wsPath}`);
console.log(`资源目录    ${assetsDir}`);
console.log(`对外地址    ${derivedOrigin}`);
console.log("");
console.log("预检");
console.log(`  外壳        ${String(report.shellBytes)} 字节`);
console.log(`  入口 bundle ${report.entryBundle ?? "(未找到)"}`);
console.log(`  relay patch ${report.patch}`);
console.log(`              ${report.detail}`);

if (report.patch === "failed") {
  console.log("");
  console.log(LINE);
  console.log("预检不通过：无法可靠地重定向 relay 地址。");
  console.log(LINE);
  console.log("若继续启动，SPA 会连回厂商 relay —— 这不是你想要的，故默认拒绝启动。");
  console.log("");
  console.log("排查方向：");
  console.log(
    "  1. 漂移检测   just patch-check " +
      posix.join(assetsDir, "assets", report.entryBundle ?? "<entry>"),
  );
  console.log("  2. 重新抓取   just fetch-assets " + assetsDir);
  console.log("  3. 确认 patch 面 docs/patching.md §5");
  console.log("");
  if (!allowUnpatched) {
    console.log("仅在排查时可用 ZCODE_SERVE_ALLOW_UNPATCHED=1 强制启动。");
    Deno.exit(1);
  }
  console.log("已设置 ZCODE_SERVE_ALLOW_UNPATCHED=1，继续启动（不推荐）。");
}

if (report.patch === "disabled") {
  console.log("");
  console.log("注意：入口 patch 被关闭，SPA 将连回厂商 relay。");
}

// ---- 启动 ----
const core = new RelayCore(logger);
const app = new Hono();
registerAssetRoutes(app, { provider: assets, logger });
registerRelayRoutes(app, { path: wsPath, core, logger, tap: undefined });

const server = Deno.serve({ hostname: host, port, onListen: () => {} }, app.fetch);

const guide = getPlatformConfigGuide({ relayUrl, derivedOrigin, port });

console.log("");
console.log(THIN);
console.log(`第 1 步：让桌面端连到这里 (${guide.osName})`);
console.log(THIN);
console.log(guide.configInstruction);
console.log("");
console.log(guide.configExample);
console.log("");
console.log("重启 ZCode 后，在界面里开启「Web 远程控制」。");
console.log("");

console.log(THIN);
console.log("第 2 步：在手机/浏览器打开");
console.log(THIN);
console.log("直接扫桌面端显示的二维码即可。等价的手工地址：");
console.log("");
console.log(`  ${derivedOrigin}/remote/v4?sid=<device_sid>&hash=<pass_hash>&t=<ts>`);
console.log("");
console.log("relay 地址由服务端注入外壳，无需手改 HTML：");
console.log(`  <meta name="zcode-relay-ws" content="${relayUrl}">`);
console.log("");

console.log(THIN);
console.log("自检");
console.log(THIN);
console.log(`  状态页   ${derivedOrigin}/`);
console.log(`  资源     curl -I ${derivedOrigin}/remote/v4/latest/`);
console.log(`  端口     ${guide.portCheckCommand}`);
console.log(LINE);

if (host === "0.0.0.0" || host === "::") {
  logger.warn(
    "绑定到全部接口：pass_hash 会暴露给该网络的所有可达主机。建议限定 VPN 接口。",
    { host },
  );
}

let shuttingDown = false;
for (const signal of ["SIGINT", "SIGTERM"] as const) {
  Deno.addSignalListener(signal, () => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info("shutting down", { signal });
    void server.shutdown().then(() => Deno.exit(0));
  });
}
