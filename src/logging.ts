/**
 * 服务日志：`@std/log` 的单点配置与本仓库 `Logger` 接口的适配。
 *
 * 生产入口（`src/relay/main.ts`、`src/serve/main.ts`）在启动时调一次
 * `setupLogging`，之后经 `createLogger()` 拿到的 `Logger` 写出的每一行
 * 都是 JSON（`{ts, level, message, ...fields}`），与迁移前的手写格式一致，
 * 便于操作侧沿用原有的日志采集。
 *
 * 测试与库代码不经过这里：它们直接注入 `SILENT` / `NOOP_LOGGER`，
 * 因此不需要预先 `setup`。
 */

import * as stdlog from "@std/log";

import type { Logger } from "./relay/relay.ts";

let configured = false;

/**
 * 单行 JSON 格式化。`message` 之后依次展开随 `info`/`warn` 传入的字段对象；
 * 未传字段时只输出前三项。
 */
function jsonLine(record: stdlog.LogRecord): string {
  const first = record.args.length > 0 ? record.args[0] : null;
  const fields = typeof first === "object" && first !== null
    ? first as Record<string, unknown>
    : {};
  return JSON.stringify({
    ts: record.datetime.toISOString(),
    level: stdlog.getLevelName(record.level as stdlog.LogLevel).toLowerCase(),
    message: record.msg,
    ...fields,
  });
}

/**
 * 配置全局日志（控制台输出，不带颜色，保证 JSON 可被逐行采集）。
 * 重复调用只有第一次生效——各入口都调一次即可，无需协调调用顺序。
 */
export function setupLogging(level: stdlog.LevelName): void {
  if (configured) return;
  configured = true;
  stdlog.setup({
    handlers: {
      console: new stdlog.ConsoleHandler(level, { formatter: jsonLine, useColors: false }),
    },
    loggers: {
      default: { level, handlers: ["console"] },
    },
  });
}

/** 取一个写 JSON 行的 `Logger`。必须在 `setupLogging` 之后调用。 */
export function createLogger(): Logger {
  const inner = stdlog.getLogger();
  return {
    info: (message, fields) => {
      inner.info(message, fields ?? {});
    },
    warn: (message, fields) => {
      inner.warn(message, fields ?? {});
    },
  };
}
