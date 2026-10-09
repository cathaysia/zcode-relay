/**
 * patch-spa 的命令行入口。逻辑见 src/tools/patch-spa.ts。
 *
 * 用法：
 *   deno task patch-check <file>            检查锚点与哈希（漂移检测）
 *   deno task patch-apply <in> <out>        应用 patch 并写出
 *
 * 典型漂移检测流程：厂商发布新构建后，先 check 现有副本，再对新抓取的
 * index-<hash>.js 跑 check，对比锚点计数。
 */

import {
  applyRelayPatch,
  inspectAnchors,
  metaTag,
  OVERRIDE_ANCHOR,
  PatchError,
} from "./patch-spa.ts";
import { sha256Hex } from "./digest.ts";
import { utf8ByteLength } from "../protocol/messages.ts";

async function check(path: string): Promise<number> {
  const source = await Deno.readTextFile(path);
  const report = inspectAnchors(source);

  console.log(`文件: ${path}`);
  console.log(`大小: ${String(utf8ByteLength(source))} 字节`);
  console.log(`sha256: ${await sha256Hex(new TextEncoder().encode(source))}`);
  console.log("");
  console.log(`锚点 "${OVERRIDE_ANCHOR}" 出现次数: ${report.overrideCount}`);
  console.log(`上下文锚点出现次数: ${report.functionCount}`);
  console.log("");

  if (report.alreadyPatched) {
    console.log("状态: 已 patch（幂等，无需处理）");
    return 0;
  }
  if (report.patchable) {
    console.log("状态: 可直接 patch");
    return 0;
  }
  console.log("状态: 锚点不匹配，无法 patch。厂商构建可能已变化。");
  console.log("      请对照 docs/patching.md §5 重新确认 patch 面。");
  return 1;
}

async function apply(input: string, output: string): Promise<number> {
  const source = await Deno.readTextFile(input);
  const patched = applyRelayPatch(source);

  if (patched === source) {
    console.log("输入已是 patch 状态，未改动。");
    return 0;
  }
  await Deno.writeTextFile(output, patched);
  console.log(`已写出: ${output}`);
  console.log("");
  console.log("部署时需要在 HTML 外壳的 <head> 内加入：");
  console.log(`  ${metaTag("wss://<你的 relay 地址>/ws")}`);
  console.log("");
  console.log("或在运行时用任意一种方式提供 relay 地址：");
  console.log("  globalThis.__ZCODE_RELAY_WS__ = 'wss://...'");
  console.log("  localStorage.setItem('zcode-relay-ws', 'wss://...')");
  return 0;
}

function usage(): void {
  console.error("用法:");
  console.error("  patch-spa-cli.ts check <file>");
  console.error("  patch-spa-cli.ts apply <in> <out>");
}

const [command, ...rest] = Deno.args;

try {
  if (command === "check" && rest.length === 1 && rest[0] !== undefined) {
    Deno.exit(await check(rest[0]));
  }
  if (command === "apply" && rest.length === 2 && rest[0] !== undefined && rest[1] !== undefined) {
    Deno.exit(await apply(rest[0], rest[1]));
  }
  usage();
  Deno.exit(2);
} catch (err) {
  if (err instanceof PatchError) {
    console.error(`patch 失败: ${err.message}`);
    Deno.exit(1);
  }
  throw err;
}
