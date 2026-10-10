/**
 * 环境变量：各入口的配置读取与 zod 校验。
 *
 * 启动时以 zod 校验：空串视为未设置、缺省值由 schema 声明、非法值
 * 在启动时直接报错退出（exit 2），而不是带着错误配置跑起来。校验只发生在
 * 启动瞬间，请求路径上零成本。
 *
 * 三个入口各取所需：
 *   - `loadRelayEnv`  relay 独立模式（`src/relay/main.ts`）
 *   - `loadServeEnv`   单端口部署（`src/serve/main.ts`，含必填的资源目录）
 *   - `loadEchoEnv`    协议核对工具（`src/tools/echo-relay.ts`）
 *
 * 入参默认读 `Deno.env`；显式传对象可做单元测试（见 `test/env.test.ts`）。
 */

import { z } from "zod";

/** 去首尾空白；空串视为未设置（保留此前手写解析的语义）。 */
const emptyAsUndefined = (value: unknown): unknown => {
  const text = typeof value === "string" ? value.trim() : value;
  return text === "" ? undefined : text;
};

const hostField = z.preprocess(emptyAsUndefined, z.string().default("127.0.0.1"));

const portField = z.preprocess(
  emptyAsUndefined,
  z.coerce.number().int().min(1).max(65535).default(18899),
);

const pathField = z.preprocess(emptyAsUndefined, z.string().default("/ws"));

/** `"1"` 开关（保留既有语义：只有字面 `1` 为真，其余一律为假）。 */
const flagField = z.preprocess(
  (value) => typeof value === "string" && value.trim() === "1",
  z.boolean(),
);

const logLevelField = z.preprocess(
  (value) => typeof value === "string" ? value.trim().toUpperCase() : value,
  z.enum(["DEBUG", "INFO", "WARN", "ERROR", "CRITICAL"]).default("INFO"),
);

const relayEnvSchema = z.object({
  ZCODE_RELAY_HOST: hostField,
  ZCODE_RELAY_PORT: portField,
  ZCODE_RELAY_PATH: pathField,
  ZCODE_LOG_LEVEL: logLevelField,
});

export type RelayEnv = z.infer<typeof relayEnvSchema>;

const serveEnvSchema = relayEnvSchema.extend({
  ZCODE_ASSETS_DIR: z.preprocess(
    emptyAsUndefined,
    z.string({
      error:
        "必须设置 ZCODE_ASSETS_DIR 指向抓取后的资源目录（先执行: just fetch-assets ./vendor-assets）",
    }).min(
      1,
    ),
  ),
  ZCODE_PUBLIC_ORIGIN: z.preprocess(
    emptyAsUndefined,
    z.string({ error: "ZCODE_PUBLIC_ORIGIN 必须是合法 URL" }).url().optional(),
  ),
  ZCODE_SERVE_NO_PATCH: flagField,
  ZCODE_SERVE_ALLOW_UNPATCHED: flagField,
});

export type ServeEnv = z.infer<typeof serveEnvSchema>;

const echoEnvSchema = relayEnvSchema.extend({
  ZCODE_ECHO_SHOW_SECRETS: flagField,
});

export type EchoEnv = z.infer<typeof echoEnvSchema>;

export function loadRelayEnv(
  source: Record<string, string | undefined> = Deno.env.toObject(),
): RelayEnv {
  return relayEnvSchema.parse(source);
}

export function loadServeEnv(
  source: Record<string, string | undefined> = Deno.env.toObject(),
): ServeEnv {
  return serveEnvSchema.parse(source);
}

export function loadEchoEnv(
  source: Record<string, string | undefined> = Deno.env.toObject(),
): EchoEnv {
  return echoEnvSchema.parse(source);
}

/** 打印校验失败的明细并以 exit 2 退出（与既有配置错误出口一致）。 */
export function reportEnvErrorAndExit(error: unknown): never {
  if (error instanceof z.ZodError) {
    console.error("环境变量错误：");
    for (const issue of error.issues) {
      const path = issue.path.map(String).join(".") || "(root)";
      console.error(`  ${path}: ${issue.message}`);
    }
  } else {
    console.error(`环境变量错误：${error instanceof Error ? error.message : String(error)}`);
  }
  Deno.exit(2);
}

function loadOrExit<T>(load: () => T): T {
  try {
    return load();
  } catch (err) {
    reportEnvErrorAndExit(err);
  }
}

/** 读 relay 入口配置，非法时打印明细并退出。 */
export function loadRelayEnvOrExit(): RelayEnv {
  return loadOrExit(loadRelayEnv);
}

/** 读单端口部署配置，非法时打印明细并退出。 */
export function loadServeEnvOrExit(): ServeEnv {
  return loadOrExit(loadServeEnv);
}

/** 读核对工具配置，非法时打印明细并退出。 */
export function loadEchoEnvOrExit(): EchoEnv {
  return loadOrExit(loadEchoEnv);
}
