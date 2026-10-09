import { assertEquals } from "@std/assert";

import { extractRefs, extractShellRefs, kindOf } from "../src/tools/asset-graph.ts";

Deno.test("提取 JS 里的相对 from 引用", () => {
  const src = `import{a}from"./chunk-A.js";import{b}from'./string-B.js';`;
  assertEquals([...extractRefs(src, "js")].sort(), ["chunk-A.js", "string-B.js"]);
});

Deno.test("提取 JS 里的动态 import", () => {
  const src = "const m=await import(`./lazy-C.js`);const n=await import('./lazy-D.js');";
  assertEquals([...extractRefs(src, "js")].sort(), ["lazy-C.js", "lazy-D.js"]);
});

Deno.test("提取 JS 里的绝对资源引用（worker / 图片 / 音频）", () => {
  const src = "new Worker(`/remote/v4/latest/assets/diffs.worker-X.js`,{type:'module'});" +
    'var p="/remote/v4/latest/assets/icon-512-abc.png";' +
    "var a=`/remote/v4/latest/assets/notify-def.mp3`;";
  assertEquals([...extractRefs(src, "js")].sort(), [
    "diffs.worker-X.js",
    "icon-512-abc.png",
    "notify-def.mp3",
  ]);
});

Deno.test("提取 CSS 里的 url()", () => {
  const css =
    "@font-face{src:url(./font-A.woff2)}.a{background:url('/remote/v4/latest/assets/bg-B.png')}";
  assertEquals([...extractRefs(css, "css")].sort(), ["bg-B.png", "font-A.woff2"]);
});

Deno.test("提取副作用导入（无绑定形式）", () => {
  const src = 'import"./side-effect-H.js";import"./plain-I.js";';
  assertEquals([...extractRefs(src, "js")].sort(), ["plain-I.js", "side-effect-H.js"]);
});

Deno.test("跳过非资源引用（data: / http: / 无扩展名）", () => {
  const src = 'var a="data:image/png;base64,AAAA";' +
    'var b="https://example.com/x.js";' +
    'import"./no-extension";' +
    'import"./real-E.js";';
  assertEquals([...extractRefs(src, "js")], ["real-E.js"]);
});

Deno.test("引用名去掉查询串与目录前缀", () => {
  const src = 'import"./sub/dir/chunk-F.js?v=2";';
  assertEquals([...extractRefs(src, "js")], ["chunk-F.js"]);
});

Deno.test("重复引用只出现一次", () => {
  const src = 'import"./x-G.js";import"./x-G.js";var y="/remote/v4/latest/assets/x-G.js";';
  assertEquals([...extractRefs(src, "js")], ["x-G.js"]);
});

Deno.test("外壳只提取绝对引用（与真实外壳一致）", () => {
  const html = '<link rel="modulepreload" href="/remote/v4/latest/assets/react-A.js">' +
    '<script type="module" src="/remote/v4/latest/assets/index-B.js"></script>' +
    '<link rel="icon" href="data:image/png;base64,AA">';
  assertEquals([...extractShellRefs(html)].sort(), ["index-B.js", "react-A.js"]);
});

Deno.test("kindOf 按扩展名分类", () => {
  assertEquals(kindOf("a.html"), "html");
  assertEquals(kindOf("a.js"), "js");
  assertEquals(kindOf("a.mjs"), "js");
  assertEquals(kindOf("a.css"), "css");
  assertEquals(kindOf("a.png"), "other");
  assertEquals(kindOf("a.mp3"), "other");
});

Deno.test("正则状态不跨调用泄漏（lastIndex 复位）", () => {
  const src = 'import"./first.js";';
  const a = extractRefs(src, "js");
  const b = extractRefs(src, "js");
  assertEquals([...a], [...b]);
});
