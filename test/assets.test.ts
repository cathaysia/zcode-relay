import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { brotliDecompressSync, gunzipSync } from "node:zlib";
import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";

import {
  AssetServer,
  findEntryBundle,
  injectRelayMeta,
} from "../src/assets/server.ts";
import { etagMatches, strongEtag } from "../src/assets/validators.ts";
import { rawGet, type RawResponse } from "./helpers/raw-http.ts";
import { OVERRIDE_EXPRESSION } from "../src/tools/patch-spa.ts";

/** 读取单值响应头。node:http 把响应头值声明为 string | string[]。 */
function header(res: RawResponse, name: string): string {
  const value = res.headers[name];
  return Array.isArray(value) ? value.join(", ") : (value ?? "");
}

// ---------- 纯函数 ----------

test("injectRelayMeta 把标签插到 <head> 之后", () => {
  const html = '<!doctype html>\n<html>\n  <head>\n    <meta charset="UTF-8" />\n  </head>\n</html>';
  const out = injectRelayMeta(html, "wss://relay.example/ws");

  assert.ok(out.includes('<meta name="zcode-relay-ws" content="wss://relay.example/ws">'));
  // 必须早于其他 head 内容，使 SPA 首次读取时已就绪
  assert.ok(out.indexOf("zcode-relay-ws") < out.indexOf('charset="UTF-8"'));
  assert.ok(out.startsWith("<!doctype html>"));
});

test("injectRelayMeta 支持带属性的 head 标签", () => {
  const out = injectRelayMeta('<html><head lang="zh"><title>x</title></head></html>', "wss://a/ws");
  assert.ok(out.includes('<head lang="zh">'));
  assert.ok(out.includes("zcode-relay-ws"));
});

test("injectRelayMeta 转义属性值", () => {
  const out = injectRelayMeta("<head></head>", 'wss://a/ws"onload="alert(1)');
  assert.ok(!out.includes('"onload="'), "属性值必须被转义");
  assert.ok(out.includes("&quot;"));
});

test("injectRelayMeta 在没有 head 时报错", () => {
  assert.throws(() => injectRelayMeta("<html><body>x</body></html>", "wss://a/ws"), /head/);
});

test("findEntryBundle 从外壳里认出 index-<hash>.js", () => {
  const html = `<script type="module" src="/remote/v4/latest/assets/index-B-ilXaCQ.js"></script>`;
  assert.equal(findEntryBundle(html), "index-B-ilXaCQ.js");
});

test("findEntryBundle 忽略同目录下其他 chunk", () => {
  const html =
    '<link rel="modulepreload" href="/remote/v4/latest/assets/react-DJIj0nWL.js">' +
    '<script type="module" src="/remote/v4/latest/assets/index-XYZ789.js"></script>';
  assert.equal(findEntryBundle(html), "index-XYZ789.js");
});

test("findEntryBundle 找不到时返回 null", () => {
  assert.equal(findEntryBundle("<html></html>"), null);
});

test("strongEtag 随内容变化且跨调用稳定", () => {
  const a = strongEtag(Buffer.from("同一份内容", "utf8"));
  assert.equal(a, strongEtag(Buffer.from("同一份内容", "utf8")), "同一内容必须得到同一指纹");
  assert.notEqual(a, strongEtag(Buffer.from("换了一份内容", "utf8")));
  assert.match(a, /^"[A-Za-z0-9_-]+"$/, "必须是带引号的强 ETag");
});

test("etagMatches 按 RFC 9110 做弱比较", () => {
  const etag = '"abc123"';
  assert.equal(etagMatches(undefined, etag), false);
  assert.equal(etagMatches(etag, etag), true);
  assert.equal(etagMatches(`W/${etag}`, etag), true, "客户端可回弱校验符");
  assert.equal(etagMatches("*", etag), true);
  assert.equal(etagMatches(`"other", ${etag}`, etag), true, "支持逗号分隔的列表");
  assert.equal(etagMatches('"other"', etag), false);
});

// ---------- 集成 ----------

const ENTRY_NAME = "index-AAA111.js";
const CHUNK_NAME = "chunk-BBB222.js";
/** 体积过压缩阈值、内容可压的普通资源，用于验证内容协商。 */
const BIG_CHUNK_NAME = "chunk-BIG333.js";
/** 扩展名表明已是压缩格式；内容故意用高度可压的全零，验证门槛按扩展名而非可压性。 */
const PNG_NAME = "logo-CCC444.png";

/** 入口 bundle 夹具：含 patch 所需的两个锚点，周围是自有代码。 */
const ENTRY_CONTENT =
  "var lead=function(){return 1};" +
  "function B4t(){return Mae({endpointOrigin:`https://zcode.z.ai`?.trim(),overrideUrl:void 0})}" +
  "var tail=function(){return 2};";

const CHUNK_CONTENT = "export const shared=1;\n";

const BIG_CHUNK_CONTENT = "export const shared = 1;\n".repeat(200);

const SHELL =
  '<!doctype html>\n<html>\n  <head>\n    <meta charset="UTF-8" />\n  </head>\n' +
  '  <body>\n' +
  // 撑过压缩阈值，使外壳（内存路径）也能在 HTTP 层验证内容协商
  "    <!--" +
  " padding".repeat(300) +
  " -->\n" +
  `    <script type="module" src="/remote/v4/latest/assets/${ENTRY_NAME}"></script>\n` +
  "  </body>\n</html>";

let root = "";
let origin = "";
let server: Server;

before(async () => {
  root = await mkdtemp(join(tmpdir(), "zcassets-"));
  await mkdir(join(root, "assets"), { recursive: true });
  await writeFile(join(root, "index.html"), SHELL, "utf8");
  await writeFile(join(root, "assets", ENTRY_NAME), ENTRY_CONTENT, "utf8");
  await writeFile(join(root, "assets", CHUNK_NAME), CHUNK_CONTENT, "utf8");
  await writeFile(join(root, "assets", BIG_CHUNK_NAME), BIG_CHUNK_CONTENT, "utf8");
  await writeFile(join(root, "assets", PNG_NAME), Buffer.alloc(4096));

  const assets = new AssetServer({ rootDir: root, relayUrl: "wss://relay.test/ws" });
  await assets.prepare();
  server = createServer(assets.handler());
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address() as AddressInfo;
  origin = `http://127.0.0.1:${String(address.port)}`;
});

after(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await rm(root, { recursive: true, force: true });
});

test("prepare 报告 patch 已套用且说明是内存 overlay", async () => {
  const fresh = new AssetServer({ rootDir: root, relayUrl: "wss://relay.test/ws" });
  const report = await fresh.prepare();
  assert.equal(report.patch, "applied");
  assert.equal(report.entryBundle, ENTRY_NAME);
  assert.match(report.detail, /磁盘文件未改动/);
});

test("服务入口 bundle 时送出 patched 内容", async () => {
  const res = await fetch(`${origin}/remote/v4/latest/assets/${ENTRY_NAME}`);
  assert.equal(res.status, 200);
  const body = await res.text();

  assert.ok(body.includes(OVERRIDE_EXPRESSION), "必须含 patch 后的运行时查找表达式");
  assert.ok(!body.includes("overrideUrl:void 0"), "不得再含原锚点");
  assert.ok(body.includes("var lead=function(){return 1};"), "其余内容应保留");
});

test("patch 只在内存，磁盘上的厂商资源保持原样", async () => {
  // 先确保已服务过（走一遍请求）
  await fetch(`${origin}/remote/v4/latest/assets/${ENTRY_NAME}`);

  const onDisk = await readFile(join(root, "assets", ENTRY_NAME), "utf8");
  assert.equal(onDisk, ENTRY_CONTENT, "磁盘文件必须逐字节未变");
  assert.ok(onDisk.includes("overrideUrl:void 0"), "磁盘上应仍是原始锚点");
});

test("patched 入口要求回源校验，但允许浏览器留副本", async () => {
  const res = await fetch(`${origin}/remote/v4/latest/assets/${ENTRY_NAME}`);
  const cacheControl = res.headers.get("cache-control") ?? "";

  assert.match(cacheControl, /no-cache/, "允许留副本，但每次复用前回源校验");
  assert.ok(
    !cacheControl.includes("no-store"),
    "no-store 会让浏览器每次重下整个入口（实测 4.6 MiB）",
  );
  assert.ok(
    !cacheControl.includes("immutable"),
    "补丁后内容已与文件名哈希不符，不得无条件复用，否则会把旧 relay 地址钉死",
  );
  assert.ok(res.headers.get("etag"), "必须带 ETag 才能协商");
});

test("入口的条件请求命中 304 且不带正文", async () => {
  const first = await fetch(`${origin}/remote/v4/latest/assets/${ENTRY_NAME}`);
  const etag = first.headers.get("etag");
  assert.ok(etag, "首次响应必须带 ETag");

  const second = await fetch(`${origin}/remote/v4/latest/assets/${ENTRY_NAME}`, {
    headers: { "if-none-match": etag },
  });
  assert.equal(second.status, 304);
  assert.equal(await second.text(), "", "304 不得带正文");
  assert.equal(second.headers.get("etag"), etag, "304 必须回 ETag，否则浏览器无法关联副本");
  assert.match(second.headers.get("cache-control") ?? "", /no-cache/);
});

test("指纹不符时不得回 304", async () => {
  const res = await fetch(`${origin}/remote/v4/latest/assets/${ENTRY_NAME}`, {
    headers: { "if-none-match": '"stale-validator"' },
  });
  assert.equal(res.status, 200, "内容未变但指纹不符时仍应正常返回");
  assert.ok((await res.text()).includes(OVERRIDE_EXPRESSION));
});

test("外壳的条件请求命中 304", async () => {
  const first = await fetch(`${origin}/remote/v4/latest/`);
  const etag = first.headers.get("etag");
  assert.ok(etag, "外壳响应必须带 ETag");

  const second = await fetch(`${origin}/remote/v4/latest/`, {
    headers: { "if-none-match": etag },
  });
  assert.equal(second.status, 304);
  assert.equal(await second.text(), "");
});

test("带哈希的普通 chunk 仍长期缓存，不做回源校验", async () => {
  const res = await fetch(`${origin}/remote/v4/latest/assets/${CHUNK_NAME}`);
  const cacheControl = res.headers.get("cache-control") ?? "";
  assert.match(cacheControl, /immutable/);
  assert.ok(!cacheControl.includes("no-cache"), "immutable 资源不该被迫回源校验");
});

test("未被 patch 的普通 chunk 仍长期缓存", async () => {
  const res = await fetch(`${origin}/remote/v4/latest/assets/${CHUNK_NAME}`);
  assert.equal(res.status, 200);
  assert.equal(await res.text(), CHUNK_CONTENT);
  assert.match(res.headers.get("cache-control") ?? "", /immutable/);
});

test("关闭 patch 时入口原样送出", async () => {
  const bare = new AssetServer({
    rootDir: root,
    relayUrl: "wss://relay.test/ws",
    patchEntryBundle: false,
  });
  const report = await bare.prepare();
  assert.equal(report.patch, "disabled");

  const server2 = createServer(bare.handler());
  await new Promise<void>((resolve) => server2.listen(0, "127.0.0.1", resolve));
  const addr = server2.address() as AddressInfo;
  try {
    const res = await fetch(
      `http://127.0.0.1:${String(addr.port)}/remote/v4/latest/assets/${ENTRY_NAME}`,
    );
    const body = await res.text();
    assert.equal(body, ENTRY_CONTENT, "关闭后应送出原始内容");
  } finally {
    await new Promise<void>((resolve) => server2.close(() => resolve()));
  }
});

test("磁盘上已被 patch 过的入口同样要求回源校验", async () => {
  // 这条路径不走内存 overlay，容易漏掉缓存策略：磁盘上的补丁产物内容
  // 同样与文件名里的哈希不符，若按 hashed 资源发 immutable 就会被钉死。
  const pre = await mkdtemp(join(tmpdir(), "zcassets-pre-serve-"));
  const preServer = new AssetServer({ rootDir: pre, relayUrl: "wss://relay.test/ws" });
  const server2 = createServer(preServer.handler());
  try {
    await mkdir(join(pre, "assets"), { recursive: true });
    await writeFile(join(pre, "index.html"), SHELL, "utf8");
    await writeFile(
      join(pre, "assets", ENTRY_NAME),
      ENTRY_CONTENT.replace("overrideUrl:void 0", OVERRIDE_EXPRESSION),
      "utf8",
    );
    assert.equal((await preServer.prepare()).patch, "already-patched", "前提：走的是无 overlay 的路径");
    await new Promise<void>((resolve) => server2.listen(0, "127.0.0.1", resolve));
    const addr = server2.address() as AddressInfo;

    const res = await fetch(
      `http://127.0.0.1:${String(addr.port)}/remote/v4/latest/assets/${ENTRY_NAME}`,
    );
    const cacheControl = res.headers.get("cache-control") ?? "";
    assert.match(cacheControl, /no-cache/);
    assert.ok(!cacheControl.includes("immutable"), "磁盘上的补丁产物同样与文件名哈希不符");
  } finally {
    await new Promise<void>((resolve) => server2.close(() => resolve()));
    await rm(pre, { recursive: true, force: true });
  }
});

test("锚点不匹配时 prepare 报告 failed 而不静默继续", async () => {
  const other = await mkdtemp(join(tmpdir(), "zcassets-bad-"));
  try {
    await mkdir(join(other, "assets"), { recursive: true });
    await writeFile(join(other, "index.html"), SHELL, "utf8");
    // 入口存在但锚点已被厂商改动
    await writeFile(
      join(other, "assets", ENTRY_NAME),
      "function B4t(){return Mae({endpointOrigin:`https://zcode.z.ai`})}",
      "utf8",
    );
    const bad = new AssetServer({ rootDir: other, relayUrl: "wss://relay.test/ws" });
    const report = await bad.prepare();
    assert.equal(report.patch, "failed");
    assert.match(report.detail, /docs\/patching\.md/);
  } finally {
    await rm(other, { recursive: true, force: true });
  }
});

test("磁盘上已被 patch 过时报告 already-patched", async () => {
  const pre = await mkdtemp(join(tmpdir(), "zcassets-pre-"));
  try {
    await mkdir(join(pre, "assets"), { recursive: true });
    await writeFile(join(pre, "index.html"), SHELL, "utf8");
    await writeFile(
      join(pre, "assets", ENTRY_NAME),
      ENTRY_CONTENT.replace("overrideUrl:void 0", OVERRIDE_EXPRESSION),
      "utf8",
    );
    const s = new AssetServer({ rootDir: pre, relayUrl: "wss://relay.test/ws" });
    const report = await s.prepare();
    assert.equal(report.patch, "already-patched");
  } finally {
    await rm(pre, { recursive: true, force: true });
  }
});

test("外壳找不到入口时回退扫描资源目录", async () => {  const scan = await mkdtemp(join(tmpdir(), "zcassets-scan-"));
  try {
    await mkdir(join(scan, "assets"), { recursive: true });
    await writeFile(join(scan, "index.html"), "<html><head></head></html>", "utf8");
    await writeFile(join(scan, "assets", ENTRY_NAME), ENTRY_CONTENT, "utf8");
    const s = new AssetServer({ rootDir: scan, relayUrl: "wss://relay.test/ws" });
    const report = await s.prepare();
    assert.equal(report.entryBundle, ENTRY_NAME, "应通过目录扫描找到入口");
    assert.equal(report.patch, "applied");
  } finally {
    await rm(scan, { recursive: true, force: true });
  }
});

// ---------- HTTP 行为 ----------

test("状态页在根路径可用并报告 patch 状态", async () => {
  const res = await fetch(`${origin}/`);
  assert.equal(res.status, 200);
  assert.match(res.headers.get("content-type") ?? "", /text\/plain/);
  const body = await res.text();
  assert.match(body, /zcode-relay asset server/);
  assert.match(body, /relay patch:/);
});

test("配对链接落点 /remote/v4 返回外壳并注入 relay 地址", async () => {
  const res = await fetch(`${origin}/remote/v4?sid=abc&hash=def&t=1`);
  assert.equal(res.status, 200);
  assert.match(res.headers.get("content-type") ?? "", /text\/html/);

  const body = await res.text();
  assert.ok(body.includes('content="wss://relay.test/ws"'), "必须注入 relay 地址");
  assert.ok(body.includes(ENTRY_NAME), "外壳内容应完整");
});

test("外壳的各个入口路径都返回外壳", async () => {
  for (const path of ["/remote/v4", "/remote/v4/", "/remote/v4/latest", "/remote/v4/latest/"]) {
    const res = await fetch(`${origin}${path}`);
    assert.equal(res.status, 200, `${path} 应返回 200`);
    assert.match(await res.text(), /index-AAA111\.js/, `${path} 应返回外壳`);
  }
});

test("外壳允许留副本但每次回源校验", async () => {
  const shell = await fetch(`${origin}/remote/v4/latest/`);
  const cacheControl = shell.headers.get("cache-control") ?? "";
  assert.match(cacheControl, /no-cache/);
  assert.ok(!cacheControl.includes("no-store"), "外壳只有 20 KB，留副本的成本远低于每次重下");
});

test("资源以正确类型与内容返回", async () => {
  const res = await fetch(`${origin}/remote/v4/latest/assets/${CHUNK_NAME}`);
  assert.equal(res.status, 200);
  assert.match(res.headers.get("content-type") ?? "", /javascript/);
  assert.equal(res.headers.get("x-content-type-options"), "nosniff");
  assert.equal(await res.text(), CHUNK_CONTENT);
});

test("HEAD 请求返回头部但无正文", async () => {
  const res = await fetch(`${origin}/remote/v4/latest/assets/${CHUNK_NAME}`, { method: "HEAD" });
  assert.equal(res.status, 200);
  assert.equal(Number(res.headers.get("content-length")), CHUNK_CONTENT.length);
  assert.equal(await res.text(), "");
});

test("缺失资源返回 404 且不误回外壳", async () => {
  const res = await fetch(`${origin}/remote/v4/latest/assets/nope-Z.js`);
  assert.equal(res.status, 404);
  assert.ok(!(await res.text()).includes(ENTRY_NAME), "不得把外壳当作资源返回");
});

test("/remote/v4 下的未知路径走 SPA fallback", async () => {
  const res = await fetch(`${origin}/remote/v4/some/deep/route`);
  assert.equal(res.status, 200);
  assert.match(await res.text(), /index-AAA111\.js/);
});

test("前缀之外的路径返回 404", async () => {
  for (const path of ["/other", "/index.html"]) {
    const res = await fetch(`${origin}${path}`);
    assert.equal(res.status, 404, `${path} 应为 404`);
  }
});

test("路径穿越不会泄露文件", async () => {
  for (const path of [
    "/remote/v4/latest/../../../../etc/passwd",
    "/remote/v4/latest/%2e%2e%2f%2e%2e%2fetc%2fpasswd",
    "/remote/v4/latest/....//....//etc/passwd",
    "/remote/v4/latest/assets/..%2f..%2f..%2fetc%2fpasswd",
  ]) {
    const res = await fetch(`${origin}${path}`, { redirect: "manual" });
    const body = await res.text();

    // 关键断言：绝不泄露宿主机文件
    assert.ok(!body.includes("root:"), `${path} 不得泄露 /etc/passwd`);
    assert.ok(!body.includes("[extensions]"), `${path} 不得泄露 /etc/passwd`);

    // 200（SPA fallback 返回外壳）、403、404 都是可接受的；
    // 不可接受的是 500 之类的异常状态
    assert.ok(
      [200, 403, 404].includes(res.status),
      `${path} 状态码异常: ${String(res.status)}`,
    );
  }
});

test("穿越尝试的两种结局都不泄露文件", async () => {
  // 字面 ../.. 会在进入服务端代码之前被 URL 规范化折叠掉，
  // 于是落进 SPA fallback（返回外壳）。这是第一层防护。
  const collapsed = await fetch(`${origin}/remote/v4/latest/assets/../../index.html`, {
    redirect: "manual",
  });
  const collapsedBody = await collapsed.text();
  assert.ok(!collapsedBody.includes("lead=function"), "不得返回宿主机文件");
  assert.ok(collapsedBody.includes(ENTRY_NAME), "折叠后应落到外壳");

  // 百分号编码的 %2f 不是路径分隔符，因此仍留在 assets/ 前缀内，
  // 交给文件解析器处理并因不存在而失败。这是第二层防护。
  const encoded = await fetch(`${origin}/remote/v4/latest/assets/..%2f..%2findex.html`, {
    redirect: "manual",
  });
  const encodedBody = await encoded.text();
  assert.equal(encoded.status, 404);
  assert.ok(!encodedBody.includes("lead=function"), "不得返回宿主机文件");
});

test("非 GET/HEAD 方法返回 405", async () => {
  const res = await fetch(`${origin}/remote/v4/latest/assets/${CHUNK_NAME}`, { method: "POST" });
  assert.equal(res.status, 405);
  assert.equal(res.headers.get("allow"), "GET, HEAD");
});

test("未注入 relay 地址时不改动外壳", async () => {
  const bare = new AssetServer({ rootDir: root });
  await bare.prepare();
  const server2 = createServer(bare.handler());
  await new Promise<void>((resolve) => server2.listen(0, "127.0.0.1", resolve));
  const addr = server2.address() as AddressInfo;
  try {
    const res = await fetch(`http://127.0.0.1:${String(addr.port)}/remote/v4/latest/`);
    const body = await res.text();
    assert.ok(!body.includes("zcode-relay-ws"), "未配置时不注入");
  } finally {
    await new Promise<void>((resolve) => server2.close(() => resolve()));
  }
});

// ---------- 内容协商与压缩 ----------
//
// 这些用 rawGet 而不是 fetch：fetch 会自动解压，看不到"服务端真的发了 br"
// 以及压缩后的字节数。

test("可压缩资源在客户端接受 br 时返回 br", async () => {
  const res = await rawGet(`${origin}/remote/v4/latest/assets/${BIG_CHUNK_NAME}`, {
    "accept-encoding": "gzip, deflate, br",
  });

  assert.equal(res.status, 200);
  assert.equal(res.headers["content-encoding"], "br");
  assert.equal(res.headers["vary"], "Accept-Encoding");
  assert.equal(Number(res.headers["content-length"]), res.body.length, "长度须是压缩后的长度");
  assert.ok(res.body.length < BIG_CHUNK_CONTENT.length, "压缩后应更小");
  assert.equal(brotliDecompressSync(res.body).toString("utf8"), BIG_CHUNK_CONTENT);
});

test("只接受 gzip 时用 gzip", async () => {
  const res = await rawGet(`${origin}/remote/v4/latest/assets/${BIG_CHUNK_NAME}`, {
    "accept-encoding": "gzip, deflate",
  });
  assert.equal(res.headers["content-encoding"], "gzip");
  assert.equal(gunzipSync(res.body).toString("utf8"), BIG_CHUNK_CONTENT);
});

test("不接受任何编码时发原文，但仍声明 Vary", async () => {
  const res = await rawGet(`${origin}/remote/v4/latest/assets/${BIG_CHUNK_NAME}`, {
    "accept-encoding": "identity",
  });
  assert.equal(res.headers["content-encoding"], undefined);
  assert.equal(
    res.headers["vary"],
    "Accept-Encoding",
    "缺了 Vary，共享缓存会把这份原文回给明确要求 br 的客户端",
  );
  assert.equal(res.body.toString("utf8"), BIG_CHUNK_CONTENT);
});

test("已压缩格式不做二次压缩", async () => {
  const res = await rawGet(`${origin}/remote/v4/latest/assets/${PNG_NAME}`, {
    "accept-encoding": "br",
  });
  assert.equal(res.status, 200);
  // 夹具内容是全零、压缩比极高；若按"可压性"判断就会误压，故这里验的是按扩展名判断
  assert.equal(res.headers["content-encoding"], undefined, "PNG 不该被压缩");
  assert.equal(res.headers["vary"], undefined, "不会被压的资源无需声明 Vary");
});

test("小于阈值的资源不压", async () => {
  const res = await rawGet(`${origin}/remote/v4/latest/assets/${CHUNK_NAME}`, {
    "accept-encoding": "br",
  });
  assert.equal(res.headers["content-encoding"], undefined, "几百字节的资源压了可能更大");
});

test("br 表示有自己的校验符，用它协商回 304", async () => {
  const br = await rawGet(`${origin}/remote/v4/latest/assets/${BIG_CHUNK_NAME}`, {
    "accept-encoding": "br",
  });
  const etag = header(br, "etag");
  assert.ok(etag, "压缩表示也应有校验符");

  const again = await rawGet(`${origin}/remote/v4/latest/assets/${BIG_CHUNK_NAME}`, {
    "accept-encoding": "br",
    "if-none-match": etag,
  });
  assert.equal(again.status, 304);
  assert.equal(again.body.length, 0);
  assert.equal(again.headers["vary"], "Accept-Encoding");
});

test("外壳（内存路径）同样按编码协商，且各有自己的校验符", async () => {
  const identity = await rawGet(`${origin}/remote/v4/latest/`, { "accept-encoding": "identity" });
  const br = await rawGet(`${origin}/remote/v4/latest/`, { "accept-encoding": "br" });

  assert.equal(identity.headers["content-encoding"], undefined);
  assert.equal(br.headers["content-encoding"], "br");
  assert.ok(br.body.length < identity.body.length);
  assert.notEqual(
    br.headers["etag"],
    identity.headers["etag"],
    "br 与 identity 是不同表示，强校验符必须不同，否则 304 会串表示",
  );

  const again = await rawGet(`${origin}/remote/v4/latest/`, {
    "accept-encoding": "br",
    "if-none-match": header(br, "etag"),
  });
  assert.equal(again.status, 304);
});
