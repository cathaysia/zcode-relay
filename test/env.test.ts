/**
 * `src/env.ts` 的单元测试：缺省值、空串语义、`"1"` 开关与非法值拒绝。
 *
 * loader 接受显式对象而非只读 `Deno.env`，故用例无需污染进程环境。
 */

import { assert, assertEquals, assertThrows } from "@std/assert";
import { ZodError } from "zod";

import { loadEchoEnv, loadRelayEnv, loadServeEnv } from "../src/env.ts";

Deno.test("缺省值：空对象得到默认 host/port/path/level", () => {
  const env = loadRelayEnv({});
  assertEquals(env.ZCODE_RELAY_HOST, "127.0.0.1");
  assertEquals(env.ZCODE_RELAY_PORT, 18899);
  assertEquals(env.ZCODE_RELAY_PATH, "/ws");
  assertEquals(env.ZCODE_LOG_LEVEL, "INFO");
});

Deno.test("空串与空白等同于未设置", () => {
  const env = loadRelayEnv({
    ZCODE_RELAY_HOST: "",
    ZCODE_RELAY_PORT: "   ",
    ZCODE_RELAY_PATH: "",
  });
  assertEquals(env.ZCODE_RELAY_HOST, "127.0.0.1");
  assertEquals(env.ZCODE_RELAY_PORT, 18899);
  assertEquals(env.ZCODE_RELAY_PATH, "/ws");
});

Deno.test("显式值去空白后透出", () => {
  const env = loadRelayEnv({
    ZCODE_RELAY_HOST: "  10.0.0.1  ",
    ZCODE_RELAY_PORT: " 19999 ",
    ZCODE_RELAY_PATH: "/relay ",
  });
  assertEquals(env.ZCODE_RELAY_HOST, "10.0.0.1");
  assertEquals(env.ZCODE_RELAY_PORT, 19999);
  assertEquals(env.ZCODE_RELAY_PATH, "/relay");
});

Deno.test("非法端口被拒绝", () => {
  for (const port of ["0", "70000", "-1", "abc", "3.5", "18899x"]) {
    assertThrows(
      () => loadRelayEnv({ ZCODE_RELAY_PORT: port }),
      ZodError,
      `端口 ${port} 应被拒绝`,
    );
  }
});

Deno.test("serve 缺资源目录时拒绝并提示抓取命令", () => {
  for (const source of [{}, { ZCODE_ASSETS_DIR: "" }, { ZCODE_ASSETS_DIR: "  " }]) {
    try {
      loadServeEnv(source);
      assert(false, "缺资源目录时必须抛错");
    } catch (err) {
      assert(err instanceof ZodError);
      assert(
        err.issues.some((issue) => issue.message.includes("just fetch-assets")),
        "错误信息应给出可执行的下一步",
      );
    }
  }
});

Deno.test("serve 开关语义：只有字面 1 为真", () => {
  const base = { ZCODE_ASSETS_DIR: "/tmp/assets" };
  assertEquals(loadServeEnv(base).ZCODE_SERVE_NO_PATCH, false);
  assertEquals(loadServeEnv({ ...base, ZCODE_SERVE_NO_PATCH: "1" }).ZCODE_SERVE_NO_PATCH, true);
  assertEquals(
    loadServeEnv({ ...base, ZCODE_SERVE_ALLOW_UNPATCHED: "true" }).ZCODE_SERVE_ALLOW_UNPATCHED,
    false,
    "true 不是 1，应为假（保留既有语义）",
  );
});

Deno.test("serve 对外地址：空缺省，非法拒绝", () => {
  assertEquals(
    loadServeEnv({ ZCODE_ASSETS_DIR: "/tmp/a", ZCODE_PUBLIC_ORIGIN: "" }).ZCODE_PUBLIC_ORIGIN,
    undefined,
  );
  assertEquals(
    loadServeEnv({ ZCODE_ASSETS_DIR: "/tmp/a", ZCODE_PUBLIC_ORIGIN: "https://zcode.internal" })
      .ZCODE_PUBLIC_ORIGIN,
    "https://zcode.internal",
  );
  assertThrows(
    () => loadServeEnv({ ZCODE_ASSETS_DIR: "/tmp/a", ZCODE_PUBLIC_ORIGIN: "not-a-url" }),
    ZodError,
  );
});

Deno.test("echo 脱敏开关默认关闭", () => {
  assertEquals(loadEchoEnv({}).ZCODE_ECHO_SHOW_SECRETS, false);
  assertEquals(loadEchoEnv({ ZCODE_ECHO_SHOW_SECRETS: "1" }).ZCODE_ECHO_SHOW_SECRETS, true);
});

Deno.test("日志级别大小写不敏感，非法拒绝", () => {
  assertEquals(loadRelayEnv({ ZCODE_LOG_LEVEL: "debug" }).ZCODE_LOG_LEVEL, "DEBUG");
  assertThrows(() => loadRelayEnv({ ZCODE_LOG_LEVEL: "verbose" }), ZodError);
});
