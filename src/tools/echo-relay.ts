/**
 * 协议核对工具。
 *
 * 用途：把真实 ZCode 桌面端指向本工具，观察它实际发出的报文，并与
 * docs/protocol.md §4.1 的记录逐条对照。
 *
 * 它同时是一个**验证器**而非单纯抓包：设备首次注册时会交出 pass_hash，
 * 本工具用该值去校验设备后续 auth_response 里的 proof。校验通过意味着
 * 本仓库的协议实现（编码、HMAC 构造、角色绑定）与真实客户端一致。
 *
 * 用法：
 *   just echo-relay 127.0.0.1 8899
 *   ZCODE_WEB_REMOTE_CONTROL_RELAY_WS_URL=ws://127.0.0.1:8899/ws /opt/ZCode/zcode
 *   然后在桌面端点击「Web 远程控制」。
 *
 * 环境变量：
 *   ZCODE_ECHO_SHOW_SECRETS=1  显示 pass_hash / proof 的实际值（默认脱敏）
 */

import { RelayServer } from "../relay/server.ts";
import type { FrameTap } from "../relay/conn.ts";
import type { Logger } from "../relay/relay.ts";

const SHOW_SECRETS = process.env["ZCODE_ECHO_SHOW_SECRETS"] === "1";

function ts(): string {
  return new Date().toISOString().slice(11, 23);
}

function redact(value: string): string {
  if (SHOW_SECRETS) return value;
  return `<${value.length} 字符，已脱敏>`;
}

/** 把一条报文压缩成一行摘要，足以与 protocol.md 对照。 */
function summarize(text: string): string {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return `非 JSON（${Buffer.byteLength(text, "utf8")} 字节）`;
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return "非对象 JSON";
  }
  const m = parsed as Record<string, unknown>;
  const type = typeof m["type"] === "string" ? m["type"] : "(缺 type)";
  const bytes = Buffer.byteLength(text, "utf8");

  switch (type) {
    case "device_register_init":
      return (
        `device_register_init  device_mid=${String(m["device_mid"])} ` +
        `pass_hash=${redact(String(m["pass_hash"]))} meta=${JSON.stringify(m["meta"])} ` +
        `[${bytes}B]`
      );
    case "auth_init":
      return (
        `auth_init  role=${String(m["role"])} device_sid=${String(m["device_sid"])} ` +
        `meta=${JSON.stringify(m["meta"])} [${bytes}B]`
      );
    case "auth_response":
      return (
        `auth_response  device_sid=${String(m["device_sid"])} ` +
        `proof=${redact(String(m["proof"]))} [${bytes}B]`
      );
    case "pair_status_query":
      return `pair_status_query  device_sid=${String(m["device_sid"])} [${bytes}B]`;
    case "data": {
      const payload = m["payload"];
      const zcodeType =
        typeof payload === "object" && payload !== null && !Array.isArray(payload)
          ? String((payload as Record<string, unknown>)["zcode_type"])
          : "?";
      return `data  zcode_type=${zcodeType} [${bytes}B]`;
    }
    default:
      return `${type} [${bytes}B]`;
  }
}

let inboundCount = 0;
let outboundCount = 0;
let sawRegister = false;
let authVerdict: "pending" | "ok" | "failed" = "pending";

const tap: FrameTap = {
  onInbound(_connId, text) {
    inboundCount += 1;
    console.log(`${ts()}  <<  ${summarize(text)}`);
  },
  onOutbound(_connId, text) {
    outboundCount += 1;
    console.log(`${ts()}  >>  ${summarize(text)}`);
  },
};

const logger: Logger = {
  info(message, fields) {
    if (message === "device registered") {
      sawRegister = true;
      console.log(`\n${ts()}  [注册] 设备已注册`);
      console.log(`         device_mid = ${String(fields?.["mid"])}`);
      console.log(`         platform   = ${String(fields?.["platform"])} ${String(fields?.["version"])}`);
      console.log("         已捕获 pass_hash，将用它校验后续 proof\n");
      return;
    }
    if (message === "authenticated") {
      const role = String(fields?.["role"]);
      console.log(`${ts()}  [认证] ${role} 认证成功`);
      if (role === "device" || role === "terminal") {
        authVerdict = "ok";
        console.log("");
        console.log("  ┌─────────────────────────────────────────────────────────────┐");
        console.log("  │ 验证通过：proof 校验成功。                                   │");
        console.log("  │ 本仓库的协议实现与真实客户端一致（编码 / HMAC / 角色绑定）。 │");
        console.log("  └─────────────────────────────────────────────────────────────┘");
        console.log("");
      }
      return;
    }
    if (message === "auth failed") {
      authVerdict = "failed";
      console.log(`${ts()}  [认证] 失败！proof 与捕获的 pass_hash 不匹配`);
      console.log("         这表示协议实现与真实客户端存在偏差，请核对 docs/protocol.md §3");
      return;
    }
    console.log(`${ts()}  [info] ${message} ${fields ? JSON.stringify(fields) : ""}`);
  },
  warn(message, fields) {
    if (message === "drop malformed message") {
      console.log(`${ts()}  [丢弃] 格式非法或超限的消息 ${fields ? JSON.stringify(fields) : ""}`);
      return;
    }
    console.log(`${ts()}  [warn] ${message} ${fields ? JSON.stringify(fields) : ""}`);
  },
};

const host = process.env["ZCODE_RELAY_HOST"]?.trim() ?? "127.0.0.1";
const port = Number(process.env["ZCODE_RELAY_PORT"]?.trim() ?? "8899");
const path = process.env["ZCODE_RELAY_PATH"]?.trim() ?? "/ws";

const server = new RelayServer({ host, port, path, logger, tap });
const address = await server.listen();

console.log("=".repeat(78));
console.log("ZCode relay 协议核对工具");
console.log("=".repeat(78));
console.log(`监听: ws://${address.address}:${address.port}${path}`);
console.log("");
console.log("在另一个终端启动桌面端，让它连到这里：");
console.log("");
console.log(`  ZCODE_WEB_REMOTE_CONTROL_RELAY_WS_URL=ws://127.0.0.1:${address.port}${path} \\`);
console.log("    /opt/ZCode/zcode");
console.log("");
console.log("然后在 ZCode 界面里开启「Web 远程控制」。");
console.log("本工具会打印设备实际发出的报文，并用捕获的 pass_hash 校验它的 proof。");
console.log("=".repeat(78));
console.log("");

const report = (): void => {
  console.log("");
  console.log("=".repeat(78));
  console.log("汇总");
  console.log("=".repeat(78));
  console.log(`入站报文 ${inboundCount} 条，出站报文 ${outboundCount} 条`);
  console.log(`是否观察到设备注册: ${sawRegister ? "是" : "否"}`);
  const verdictText =
    authVerdict === "ok"
      ? "通过 —— 协议实现与真实客户端一致"
      : authVerdict === "failed"
        ? "失败 —— 协议存在偏差"
        : "未完成（未观察到成功的认证）";
  console.log(`协议验证: ${verdictText}`);
  console.log("=".repeat(78));
};

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    report();
    void server.close().then(() => process.exit(0));
  });
}
