/**
 * 回归测试：`just serve` 不得覆盖调用方的 `ZCODE_ASSETS_DIR`。
 *
 * 背景：配方曾无条件 `export ZCODE_ASSETS_DIR="{{assetsdir}}"`（默认值
 * `vendor-assets`），调用方导出的变量被静默丢掉，服务实际去
 * `vendor-assets/assets` 下找资源——"assetsdir 没生效"。
 * 修法：参数默认值改从环境读（`env_var_or_default`），空串回退默认。
 *
 * 用桩目录（只有 index.html、没有入口 bundle）驱动：服务会在打印启动
 * 横幅后因预检失败退出，全程不监听端口、不碰网络。断言横幅里的资源目录
 * 即传入的目录，且未触发自动抓取。
 */

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { fromFileUrl } from "@std/path";
import * as posix from "@std/path/posix";

const REPO_ROOT = fromFileUrl(new URL("../", import.meta.url));

function justAvailable(): boolean {
  try {
    const out = new Deno.Command("just", {
      args: ["--version"],
      stdout: "null",
      stderr: "null",
    }).outputSync();
    return out.success;
  } catch {
    return false;
  }
}

const JUST_AVAILABLE = justAvailable();
if (!JUST_AVAILABLE) {
  console.warn("just 不可用：跳过 serve 配方回归测试，这条不变式本次未被验证");
}

const STUB_SHELL = "<!doctype html><html><head></head><body>stub</body></html>";

interface ServeRun {
  readonly code: number;
  readonly output: string;
}

/** 跑一次 `just serve`，桩目录保证它在横幅后即退出（预检失败）。 */
async function runJustServe(
  args: string[],
  env: Record<string, string>,
  timeoutMs = 60_000,
): Promise<ServeRun> {
  const child = new Deno.Command("just", {
    args,
    cwd: REPO_ROOT,
    env,
    stdout: "piped",
    stderr: "piped",
  }).spawn();

  const timer = setTimeout(() => {
    try {
      child.kill("SIGKILL");
    } catch {
      // 已退出
    }
  }, timeoutMs);
  let output: Deno.CommandOutput;
  try {
    output = await child.output();
  } finally {
    clearTimeout(timer);
  }
  const decode = (bytes: Uint8Array): string => new TextDecoder().decode(bytes);
  return { code: output.code, output: decode(output.stdout) + decode(output.stderr) };
}

async function withStubDir(fn: (dir: string) => Promise<void>): Promise<void> {
  const dir = await Deno.makeTempDir({ prefix: "zcserve-" });
  try {
    await Deno.writeTextFile(posix.join(dir, "index.html"), STUB_SHELL);
    await fn(dir);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
}

function baseEnv(): Record<string, string> {
  const env = Deno.env.toObject();
  delete env["ZCODE_ASSETS_DIR"];
  return env;
}

Deno.test({
  name: "just serve 尊重环境里的 ZCODE_ASSETS_DIR",
  ignore: !JUST_AVAILABLE,
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    await withStubDir(async (stub) => {
      const run = await runJustServe(
        ["serve", "127.0.0.1", "18911"],
        { ...baseEnv(), ZCODE_ASSETS_DIR: stub },
      );
      assertEquals(run.code, 1, `桩目录应使预检失败退出，实际输出:\n${run.output}`);
      assertStringIncludes(run.output, stub, "横幅里的资源目录应是环境传入的目录");
      assert(
        !run.output.includes("自动抓取"),
        "桩里已有 index.html，不应触发抓取；出现抓取说明用的不是该目录",
      );
    });
  },
});

Deno.test({
  name: "just serve 的位置参数仍可指定资源目录",
  ignore: !JUST_AVAILABLE,
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    await withStubDir(async (stub) => {
      const run = await runJustServe(
        ["serve", "127.0.0.1", "18912", stub],
        baseEnv(),
      );
      assertEquals(run.code, 1, `桩目录应使预检失败退出，实际输出:\n${run.output}`);
      assertStringIncludes(run.output, stub, "横幅里的资源目录应是位置参数传入的目录");
      assert(
        !run.output.includes("自动抓取"),
        "桩里已有 index.html，不应触发抓取；出现抓取说明用的不是该目录",
      );
    });
  },
});
