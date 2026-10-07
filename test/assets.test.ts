import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";

import { AssetServer, injectRelayMeta } from "../src/assets/server.ts";

// ---------- 纯函数 ----------

test("injectRelayMeta 把标签插到 <head> 之后", () => {
  const html = "<!doctype html>\n<html>\n  <head>\n    <meta charset=\"UTF-8\" />\n  </head>\n</html>";
  const out = injectRelayMeta(html, "wss://relay.example/ws");

  assert.ok(out.includes('<meta name="zcode-relay-ws" content="wss://relay.example/ws">'));
  // 必须早于其他 head 内容，使 SPA 首次读取时已就绪
  assert.ok(out.indexOf("zcode-relay-ws") < out.indexOf('charset="UTF-8"'));
  // 其余内容不被破坏
  assert.ok(out.includes("<body") === false);
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

// ---------- 集成：真实 HTTP 请求 ----------

const SHELL =
  '<!doctype html>\n<html>\n  <head>\n    <meta charset="UTF-8" />\n  </head>\n' +
  '  <body>\n    <script type="module" src="/remote/v4/latest/assets/index-A.js"></script>\n  </body>\n</html>';

const CHUNK = "export const x=1;\n";

let root = "";
let server: Server;
let origin = "";

before(async () => {
  root = await mkdtemp(join(tmpdir(), "zcassets-"));
  await mkdir(join(root, "assets"), { recursive: true });
  await writeFile(join(root, "index.html"), SHELL, "utf8");
  await writeFile(join(root, "assets", "index-A.js"), CHUNK, "utf8");

  const assets = new AssetServer({ rootDir: root, relayUrl: "wss://relay.test/ws" });
  server = createServer(assets.handler());
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address() as AddressInfo;
  origin = `http://127.0.0.1:${String(address.port)}`;
});

after(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await rm(root, { recursive: true, force: true });
});

test("状态页在根路径可用", async () => {
  const res = await fetch(`${origin}/`);
  assert.equal(res.status, 200);
  assert.match(res.headers.get("content-type") ?? "", /text\/plain/);
  const body = await res.text();
  assert.match(body, /zcode-relay asset server/);
});

test("配对链接落点 /remote/v4 返回外壳并注入 relay 地址", async () => {
  const res = await fetch(`${origin}/remote/v4?sid=abc&hash=def&t=1`);
  assert.equal(res.status, 200);
  assert.match(res.headers.get("content-type") ?? "", /text\/html/);

  const body = await res.text();
  assert.ok(body.includes('content="wss://relay.test/ws"'), "必须注入 relay 地址");
  assert.ok(body.includes("index-A.js"), "外壳内容应完整");
});

test("外壳的各个入口路径都返回外壳", async () => {
  for (const path of ["/remote/v4", "/remote/v4/", "/remote/v4/latest", "/remote/v4/latest/"]) {
    const res = await fetch(`${origin}${path}`);
    assert.equal(res.status, 200, `${path} 应返回 200`);
    assert.match(await res.text(), /index-A\.js/, `${path} 应返回外壳`);
  }
});

test("外壳不缓存，带哈希的资源长期缓存", async () => {
  const shell = await fetch(`${origin}/remote/v4/latest/`);
  assert.match(shell.headers.get("cache-control") ?? "", /no-store/);

  const chunk = await fetch(`${origin}/remote/v4/latest/assets/index-A.js`);
  assert.match(chunk.headers.get("cache-control") ?? "", /immutable/);
});

test("资源以正确类型与内容返回", async () => {
  const res = await fetch(`${origin}/remote/v4/latest/assets/index-A.js`);
  assert.equal(res.status, 200);
  assert.match(res.headers.get("content-type") ?? "", /javascript/);
  assert.equal(res.headers.get("x-content-type-options"), "nosniff");
  assert.equal(await res.text(), CHUNK);
});

test("HEAD 请求返回头部但无正文", async () => {
  const res = await fetch(`${origin}/remote/v4/latest/assets/index-A.js`, { method: "HEAD" });
  assert.equal(res.status, 200);
  assert.equal(Number(res.headers.get("content-length")), CHUNK.length);
  assert.equal(await res.text(), "");
});

test("缺失资源返回 404 且不误回外壳", async () => {
  const res = await fetch(`${origin}/remote/v4/latest/assets/nope-Z.js`);
  assert.equal(res.status, 404);
  assert.ok(!(await res.text()).includes("index-A.js"), "不得把外壳当作资源返回");
});

test("/remote/v4 下的未知路径走 SPA fallback", async () => {
  const res = await fetch(`${origin}/remote/v4/some/deep/route`);
  assert.equal(res.status, 200);
  assert.match(await res.text(), /index-A\.js/);
});

test("前缀之外的路径返回 404", async () => {
  for (const path of ["/", "/other", "/index.html"].slice(1)) {
    const res = await fetch(`${origin}${path}`);
    assert.equal(res.status, 404, `${path} 应为 404`);
  }
});

test("拒绝路径穿越（字面与百分号编码两种）", async () => {
  for (const path of [
    "/remote/v4/latest/../../../../etc/passwd",
    "/remote/v4/latest/%2e%2e%2f%2e%2e%2fetc%2fpasswd",
    "/remote/v4/latest/....//....//etc/passwd",
  ]) {
    const res = await fetch(`${origin}${path}`, { redirect: "manual" });
    const body = await res.text();
    assert.ok(res.status !== 200, `${path} 不得返回 200`);
    assert.ok(!body.includes("root:"), `${path} 不得泄露 /etc/passwd`);
  }
});

test("非 GET/HEAD 方法返回 405", async () => {
  const res = await fetch(`${origin}/remote/v4/latest/assets/index-A.js`, { method: "POST" });
  assert.equal(res.status, 405);
  assert.equal(res.headers.get("allow"), "GET, HEAD");
});

test("未注入 relay 地址时不改动外壳", async () => {
  const bare = new AssetServer({ rootDir: root });
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
