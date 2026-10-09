import { assert, assertEquals, assertThrows, fail } from "@std/assert";

import {
  applyRelayPatch,
  countOccurrences,
  inspectAnchors,
  metaTag,
  OVERRIDE_ANCHOR,
  OVERRIDE_EXPRESSION,
  PatchError,
} from "../src/tools/patch-spa.ts";

/**
 * 合成夹具：只保留 patch 所需的两个锚点，周围是自有代码。
 * 不包含任何厂商文件的实质内容。
 */
const PATCHABLE = [
  "var unrelatedBefore=function(){return 1};",
  "function B4t(){return Mae({endpointOrigin:`https://zcode.z.ai`?.trim(),overrideUrl:void 0})}",
  "var unrelatedAfter=function(){return 2};",
].join("");

/** 已被 patch 过的形态。 */
const ALREADY_PATCHED = PATCHABLE.replace(OVERRIDE_ANCHOR, OVERRIDE_EXPRESSION);

Deno.test("inspectAnchors 识别可 patch 的构建", () => {
  const report = inspectAnchors(PATCHABLE);
  assertEquals(report.overrideCount, 1);
  assertEquals(report.functionCount, 1);
  assertEquals(report.patchable, true);
  assertEquals(report.alreadyPatched, false);
});

Deno.test("applyRelayPatch 替换锚点为运行时查找表达式", () => {
  const patched = applyRelayPatch(PATCHABLE);

  assertEquals(countOccurrences(patched, OVERRIDE_ANCHOR), 0, "原锚点应消失");
  assertEquals(countOccurrences(patched, OVERRIDE_EXPRESSION), 1, "新表达式应出现一次");
  // 周围代码不受影响
  assert(patched.includes("var unrelatedBefore=function(){return 1};"));
  assert(patched.includes("var unrelatedAfter=function(){return 2};"));
});

Deno.test("patch 后仍是合法 JavaScript", () => {
  const patched = applyRelayPatch(PATCHABLE);
  // new Function 只做语法解析，不执行，因此不需要 document/localStorage
  try {
    new Function(patched);
  } catch (err) {
    fail(`patch 产物必须语法合法: ${err instanceof Error ? err.message : String(err)}`);
  }
});

Deno.test("patch 是幂等的", () => {
  const once = applyRelayPatch(PATCHABLE);
  const twice = applyRelayPatch(once);
  assertEquals(twice, once, "重复 patch 不得改变内容");

  const report = inspectAnchors(once);
  assertEquals(report.alreadyPatched, true);
  assertEquals(report.overrideCount, 0, "已 patch 后原锚点计数应为 0");
});

Deno.test("已 patch 的输入不抛错且原样返回", () => {
  const report = inspectAnchors(ALREADY_PATCHED);
  assertEquals(report.alreadyPatched, true);
  assertEquals(applyRelayPatch(ALREADY_PATCHED), ALREADY_PATCHED);
});

Deno.test("锚点缺失时抛 PatchError（厂商构建变化）", () => {
  const changed = "function B4t(){return Mae({endpointOrigin:`https://zcode.z.ai`})}";
  assertThrows(() => applyRelayPatch(changed), PatchError);
  // 报错信息应指向漂移排查
  try {
    applyRelayPatch(changed);
    fail("应当抛错");
  } catch (err) {
    assert(err instanceof PatchError);
    assert(
      err.message.includes("docs/patching.md"),
      `报错应指向 docs/patching.md，实际: ${err.message}`,
    );
  }
});

Deno.test("锚点重复出现时拒绝 patch（避免替换到错误位置）", () => {
  const duplicated = `${PATCHABLE}${PATCHABLE}`;
  const report = inspectAnchors(duplicated);
  assertEquals(report.overrideCount, 2);
  assertEquals(report.patchable, false);
  assertThrows(() => applyRelayPatch(duplicated), PatchError);
});

Deno.test("上下文锚点缺失时拒绝 patch（可能不是目标构建）", () => {
  // overrideUrl:void 0 有，但不在 B4t 里
  const wrongContext = "var x={overrideUrl:void 0};";
  const report = inspectAnchors(wrongContext);
  assertEquals(report.overrideCount, 1);
  assertEquals(report.functionCount, 0);
  assertEquals(report.patchable, false);
  assertThrows(() => applyRelayPatch(wrongContext), PatchError);
});

Deno.test("countOccurrences 不重叠计数", () => {
  assertEquals(countOccurrences("aaaa", "aa"), 2);
  assertEquals(countOccurrences("abc", "z"), 0);
  assertEquals(countOccurrences("abc", ""), 0);
});

Deno.test("metaTag 产出可插入 head 的标签", () => {
  const tag = metaTag("wss://relay.example.com/ws");
  assertEquals(tag, '<meta name="zcode-relay-ws" content="wss://relay.example.com/ws" />');
});

Deno.test("替换表达式按 meta → 全局 → localStorage 顺序查找，且失败安全", () => {
  // 顺序断言：meta 在最前，void 0 在最后
  const expr = OVERRIDE_EXPRESSION;
  const metaAt = expr.indexOf("meta[name=");
  const globalAt = expr.indexOf("__ZCODE_RELAY_WS__");
  const storageAt = expr.indexOf("localStorage");
  const fallbackAt = expr.indexOf("void 0");

  assert(metaAt >= 0 && globalAt > metaAt, "meta 应先于全局变量");
  assert(storageAt > globalAt, "全局变量应先于 localStorage");
  assert(fallbackAt > storageAt, "最终必须回退到 void 0");
});
