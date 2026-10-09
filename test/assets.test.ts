import {
  assert,
  assertEquals,
  assertMatch,
  assertNotEquals,
  assertStringIncludes,
} from "@std/assert";
import { brotliDecompressSync, gunzipSync } from "node:zlib";
import * as posix from "@std/path/posix";

import { AssetProvider, findEntryBundle, injectRelayMeta } from "../src/assets/provider.ts";
import { classifyRoute } from "../src/assets/routes.ts";
import { etagMatches, strongEtag } from "../src/assets/validators.ts";
import { OVERRIDE_EXPRESSION } from "../src/tools/patch-spa.ts";
import { settleEventLoop } from "./helpers/settle.ts";
import {
  type AssetFixture,
  type AssetFixtureOptions,
  BIG_CHUNK_CONTENT,
  BIG_CHUNK_NAME,
  buildAssetApp,
  CHUNK_CONTENT,
  CHUNK_NAME,
  createAssetFixture,
  ENTRY_CONTENT,
  ENTRY_NAME,
  header,
  makeFixtureRoot,
  PNG_NAME,
  RELAY_URL,
  SHELL,
} from "./helpers/asset-app.ts";

const utf8 = (bytes: Uint8Array): string => new TextDecoder().decode(bytes);

/** 每条用例一棵夹具树 + 一个 Fastify 实例，结束即拆。 */
async function withFixture<T>(
  fn: (f: AssetFixture) => Promise<T>,
  options: AssetFixtureOptions = {},
): Promise<T> {
  const fixture = await createAssetFixture(options);
  try {
    return await fn(fixture);
  } finally {
    await fixture.close();
  }
}

/** 临时目录 + 自定义内容，用于 prepare() 的边界用例。 */
async function withRoot<T>(fn: (root: string) => Promise<T>): Promise<T> {
  const root = await Deno.makeTempDir({ prefix: "zcassets-" });
  try {
    return await fn(root);
  } finally {
    await Deno.remove(root, { recursive: true });
  }
}

// ---------- 纯函数 ----------

Deno.test("injectRelayMeta 把标签插到 <head> 之后", () => {
  const html =
    '<!doctype html>\n<html>\n  <head>\n    <meta charset="UTF-8" />\n  </head>\n</html>';
  const out = injectRelayMeta(html, "wss://relay.example/ws");

  assert(out.includes('<meta name="zcode-relay-ws" content="wss://relay.example/ws">'));
  // 必须早于其他 head 内容，使 SPA 首次读取时已就绪
  assert(out.indexOf("zcode-relay-ws") < out.indexOf('charset="UTF-8"'));
  assert(out.startsWith("<!doctype html>"));
});

Deno.test("injectRelayMeta 支持带属性的 head 标签", () => {
  const out = injectRelayMeta('<html><head lang="zh"><title>x</title></head></html>', "wss://a/ws");
  assert(out.includes('<head lang="zh">'));
  assert(out.includes("zcode-relay-ws"));
});

Deno.test("injectRelayMeta 转义属性值", () => {
  const out = injectRelayMeta("<head></head>", 'wss://a/ws"onload="alert(1)');
  assert(!out.includes('"onload="'), "属性值必须被转义");
  assert(out.includes("&quot;"));
});

Deno.test("injectRelayMeta 在没有 head 时报错", () => {
  let threw = false;
  try {
    injectRelayMeta("<html><body>x</body></html>", "wss://a/ws");
  } catch (err) {
    threw = true;
    assertStringIncludes(err instanceof Error ? err.message : "", "head");
  }
  assert(threw, "没有 <head> 时必须报错");
});

Deno.test("findEntryBundle 从外壳里认出 index-<hash>.js", () => {
  const html = `<script type="module" src="/remote/v4/latest/assets/index-B-ilXaCQ.js"></script>`;
  assertEquals(findEntryBundle(html), "index-B-ilXaCQ.js");
});

Deno.test("findEntryBundle 忽略同目录下其他 chunk", () => {
  const html = '<link rel="modulepreload" href="/remote/v4/latest/assets/react-DJIj0nWL.js">' +
    '<script type="module" src="/remote/v4/latest/assets/index-XYZ789.js"></script>';
  assertEquals(findEntryBundle(html), "index-XYZ789.js");
});

Deno.test("findEntryBundle 找不到时返回 null", () => {
  assertEquals(findEntryBundle("<html></html>"), null);
});

Deno.test("strongEtag 随内容变化且跨调用稳定", async () => {
  const a = await strongEtag(new TextEncoder().encode("同一份内容"));
  assertEquals(
    a,
    await strongEtag(new TextEncoder().encode("同一份内容")),
    "同一内容必须得到同一指纹",
  );
  assertNotEquals(a, await strongEtag(new TextEncoder().encode("换了一份内容")));
  assertMatch(a, /^"[A-Za-z0-9_-]+"$/, "必须是带引号的强 ETag");
});

Deno.test("etagMatches 按 RFC 9110 做弱比较", () => {
  const etag = '"abc123"';
  assertEquals(etagMatches(undefined, etag), false);
  assertEquals(etagMatches(etag, etag), true);
  assertEquals(etagMatches(`W/${etag}`, etag), true, "客户端可回弱校验符");
  assertEquals(etagMatches("*", etag), true);
  assertEquals(etagMatches(`"other", ${etag}`, etag), true, "支持逗号分隔的列表");
  assertEquals(etagMatches('"other"', etag), false);
});

Deno.test("路径表：外壳、资源与 404 三种结局", () => {
  for (const path of ["/remote/v4", "/remote/v4/", "/remote/v4/latest", "/remote/v4/latest/"]) {
    assertEquals(classifyRoute(path).kind, "shell", `${path} 应回外壳`);
  }
  assertEquals(classifyRoute("/remote/v4/latest/assets/index-A.js"), {
    kind: "asset",
    relative: "assets/index-A.js",
  });
  // SPA 应用路由（含 worker 用的绝对路径之外的深层路由）
  assertEquals(classifyRoute("/remote/v4/some/deep/route").kind, "shell");
  assertEquals(classifyRoute("/other").kind, "notfound");
  assertEquals(classifyRoute("/index.html").kind, "notfound");
  // 规范化后的路径才是判定输入：折叠出前缀之外的一律 404
  assertEquals(classifyRoute("/etc/passwd").kind, "notfound");
});

// ---------- prepare 预检 ----------

Deno.test("prepare 报告 patch 已套用且说明是内存 overlay", async () => {
  await withFixture(async ({ provider }) => {
    const report = await provider.prepare();
    assertEquals(report.patch, "applied");
    assertEquals(report.entryBundle, ENTRY_NAME);
    assertMatch(report.detail, /磁盘文件未改动/);
  });
});

Deno.test("锚点不匹配时 prepare 报告 failed 而不静默继续", async () => {
  await withRoot(async (root) => {
    await Deno.mkdir(posix.join(root, "assets"), { recursive: true });
    await Deno.writeTextFile(posix.join(root, "index.html"), SHELL);
    // 入口存在但锚点已被厂商改动
    await Deno.writeTextFile(
      posix.join(root, "assets", ENTRY_NAME),
      "function B4t(){return Mae({endpointOrigin:`https://zcode.z.ai`})}",
    );
    const provider = new AssetProvider({ rootDir: root, relayUrl: RELAY_URL });
    const report = await provider.prepare();
    assertEquals(report.patch, "failed");
    assertMatch(report.detail, /docs\/patching\.md/);
  });
});

Deno.test("磁盘上已被 patch 过时报告 already-patched", async () => {
  await withRoot(async (root) => {
    await Deno.mkdir(posix.join(root, "assets"), { recursive: true });
    await Deno.writeTextFile(posix.join(root, "index.html"), SHELL);
    await Deno.writeTextFile(
      posix.join(root, "assets", ENTRY_NAME),
      ENTRY_CONTENT.replace("overrideUrl:void 0", OVERRIDE_EXPRESSION),
    );
    const provider = new AssetProvider({ rootDir: root, relayUrl: RELAY_URL });
    assertEquals((await provider.prepare()).patch, "already-patched");
  });
});

Deno.test("外壳找不到入口时回退扫描资源目录", async () => {
  await withRoot(async (root) => {
    await Deno.mkdir(posix.join(root, "assets"), { recursive: true });
    await Deno.writeTextFile(posix.join(root, "index.html"), "<html><head></head></html>");
    await Deno.writeTextFile(posix.join(root, "assets", ENTRY_NAME), ENTRY_CONTENT);
    const provider = new AssetProvider({ rootDir: root, relayUrl: RELAY_URL });
    const report = await provider.prepare();
    assertEquals(report.entryBundle, ENTRY_NAME, "应通过目录扫描找到入口");
    assertEquals(report.patch, "applied");
  });
});

// ---------- 入口 bundle 的内存 overlay ----------

Deno.test("服务入口 bundle 时送出 patched 内容", async () => {
  await withFixture(async ({ app, provider }) => {
    await provider.prepare();
    const res = await app.inject({ url: `/remote/v4/latest/assets/${ENTRY_NAME}` });
    assertEquals(res.statusCode, 200);
    const body = res.body;

    assertStringIncludes(body, OVERRIDE_EXPRESSION, "必须含 patch 后的运行时查找表达式");
    assert(!body.includes("overrideUrl:void 0"), "不得再含原锚点");
    assertStringIncludes(body, "var lead=function(){return 1};", "其余内容应保留");
  });
});

Deno.test("patch 只在内存，磁盘上的厂商资源保持原样", async () => {
  await withFixture(async ({ app, provider, root }) => {
    await provider.prepare();
    await app.inject({ url: `/remote/v4/latest/assets/${ENTRY_NAME}` });

    const onDisk = await Deno.readTextFile(posix.join(root, "assets", ENTRY_NAME));
    assertEquals(onDisk, ENTRY_CONTENT, "磁盘文件必须逐字节未变");
    assertStringIncludes(onDisk, "overrideUrl:void 0", "磁盘上应仍是原始锚点");
  });
});

Deno.test("关闭 patch 时入口原样送出", async () => {
  await withFixture(async ({ app, provider }) => {
    const report = await provider.prepare();
    assertEquals(report.patch, "disabled");

    const res = await app.inject({ url: `/remote/v4/latest/assets/${ENTRY_NAME}` });
    assertEquals(res.body, ENTRY_CONTENT, "关闭后应送出原始内容");
  }, { patchEntryBundle: false });
});

Deno.test("磁盘上已被 patch 过的入口同样要求回源校验", async () => {
  // 这条路径不走内存 overlay，容易漏掉缓存策略：磁盘上的补丁产物内容
  // 同样与文件名里的哈希不符，若按 hashed 资源发 immutable 就会被钉死。
  await withRoot(async (root) => {
    await Deno.mkdir(posix.join(root, "assets"), { recursive: true });
    await Deno.writeTextFile(posix.join(root, "index.html"), SHELL);
    await Deno.writeTextFile(
      posix.join(root, "assets", ENTRY_NAME),
      ENTRY_CONTENT.replace("overrideUrl:void 0", OVERRIDE_EXPRESSION),
    );
    const provider = new AssetProvider({ rootDir: root, relayUrl: RELAY_URL });
    assertEquals((await provider.prepare()).patch, "already-patched", "前提：走无 overlay 的路径");
    const app = buildAssetApp(provider);

    const res = await app.inject({ url: `/remote/v4/latest/assets/${ENTRY_NAME}` });
    const cacheControl = header(res, "cache-control");
    assertMatch(cacheControl, /no-cache/);
    assert(!cacheControl.includes("immutable"), "磁盘上的补丁产物同样与文件名哈希不符");

    await app.close();
    await settleEventLoop();
  });
});

// ---------- 缓存语义与条件请求 ----------

Deno.test("patched 入口要求回源校验，但允许浏览器留副本", async () => {
  await withFixture(async ({ app, provider }) => {
    await provider.prepare();
    const res = await app.inject({ url: `/remote/v4/latest/assets/${ENTRY_NAME}` });
    const cacheControl = header(res, "cache-control");

    assertMatch(cacheControl, /no-cache/, "允许留副本，但每次复用前回源校验");
    assert(
      !cacheControl.includes("no-store"),
      "no-store 会让浏览器每次重下整个入口（实测 4.6 MiB）",
    );
    assert(
      !cacheControl.includes("immutable"),
      "补丁后内容已与文件名哈希不符，不得无条件复用，否则会把旧 relay 地址钉死",
    );
    assert(header(res, "etag"), "必须带 ETag 才能协商");
  });
});

Deno.test("入口的条件请求命中 304 且不带正文", async () => {
  await withFixture(async ({ app, provider }) => {
    await provider.prepare();
    const first = await app.inject({ url: `/remote/v4/latest/assets/${ENTRY_NAME}` });
    const etag = header(first, "etag");
    assert(etag, "首次响应必须带 ETag");

    const second = await app.inject({
      url: `/remote/v4/latest/assets/${ENTRY_NAME}`,
      headers: { "if-none-match": etag },
    });
    assertEquals(second.statusCode, 304);
    assertEquals(second.body, "", "304 不得带正文");
    assertEquals(header(second, "etag"), etag, "304 必须回 ETag，否则浏览器无法关联副本");
    assertMatch(header(second, "cache-control"), /no-cache/);
  });
});

Deno.test("指纹不符时不得回 304", async () => {
  await withFixture(async ({ app, provider }) => {
    await provider.prepare();
    const res = await app.inject({
      url: `/remote/v4/latest/assets/${ENTRY_NAME}`,
      headers: { "if-none-match": '"stale-validator"' },
    });
    assertEquals(res.statusCode, 200, "内容未变但指纹不符时仍应正常返回");
    assertStringIncludes(res.body, OVERRIDE_EXPRESSION);
  });
});

Deno.test("外壳的条件请求命中 304", async () => {
  await withFixture(async ({ app }) => {
    const first = await app.inject({ url: "/remote/v4/latest/" });
    const etag = header(first, "etag");
    assert(etag, "外壳响应必须带 ETag");

    const second = await app.inject({
      url: "/remote/v4/latest/",
      headers: { "if-none-match": etag },
    });
    assertEquals(second.statusCode, 304);
    assertEquals(second.body, "");
  });
});

Deno.test("带哈希的普通 chunk 仍长期缓存，不做回源校验", async () => {
  await withFixture(async ({ app, provider }) => {
    await provider.prepare();
    const res = await app.inject({ url: `/remote/v4/latest/assets/${CHUNK_NAME}` });
    const cacheControl = header(res, "cache-control");
    assertMatch(cacheControl, /immutable/);
    assert(!cacheControl.includes("no-cache"), "immutable 资源不该被迫回源校验");
    assertEquals(res.body, CHUNK_CONTENT);
    assertMatch(header(res, "content-type"), /javascript/);
    assertEquals(header(res, "x-content-type-options"), "nosniff");
  });
});

// ---------- 路由与 HTTP 语义 ----------

Deno.test("状态页在根路径可用并报告 patch 状态", async () => {
  await withFixture(async ({ app, provider }) => {
    await provider.prepare();
    for (const path of ["/", "/healthz"]) {
      const res = await app.inject({ url: path });
      assertEquals(res.statusCode, 200, `${path} 应可用`);
      assertMatch(header(res, "content-type"), /text\/plain/);
      assertMatch(res.body, /zcode-relay asset server/);
      assertMatch(res.body, /relay patch:/);
    }
  });
});

Deno.test("配对链接落点 /remote/v4 返回外壳并注入 relay 地址", async () => {
  await withFixture(async ({ app, provider }) => {
    await provider.prepare();
    const res = await app.inject({ url: "/remote/v4?sid=abc&hash=def&t=1" });
    assertEquals(res.statusCode, 200);
    assertMatch(header(res, "content-type"), /text\/html/);

    assertStringIncludes(res.body, `content="${RELAY_URL}"`, "必须注入 relay 地址");
    assertStringIncludes(res.body, ENTRY_NAME, "外壳内容应完整");
  });
});

Deno.test("外壳的各个入口路径都返回外壳", async () => {
  await withFixture(async ({ app, provider }) => {
    await provider.prepare();
    for (const path of ["/remote/v4", "/remote/v4/", "/remote/v4/latest", "/remote/v4/latest/"]) {
      const res = await app.inject({ url: path });
      assertEquals(res.statusCode, 200, `${path} 应返回 200`);
      assertMatch(res.body, /index-AAA111\.js/, `${path} 应返回外壳`);
    }
  });
});

Deno.test("外壳允许留副本但每次回源校验", async () => {
  await withFixture(async ({ app }) => {
    const shell = await app.inject({ url: "/remote/v4/latest/" });
    const cacheControl = header(shell, "cache-control");
    assertMatch(cacheControl, /no-cache/);
    assert(!cacheControl.includes("no-store"), "外壳只有 20 KB，留副本的成本远低于每次重下");
  });
});

Deno.test("未注入 relay 地址时不改动外壳", async () => {
  // 用低层构造：夹具助手默认会注入 RELAY_URL，这里要的正是"没配 relayUrl"。
  const root = await makeFixtureRoot();
  const provider = new AssetProvider({ rootDir: root });
  const app = buildAssetApp(provider);
  try {
    await provider.prepare();
    const res = await app.inject({ url: "/remote/v4/latest/" });
    assert(!res.body.includes("zcode-relay-ws"), "未配置时不注入");
  } finally {
    await app.close();
    await Deno.remove(root, { recursive: true });
    await settleEventLoop();
  }
});

Deno.test("HEAD 请求返回头部但无正文", async () => {
  await withFixture(async ({ app, provider }) => {
    await provider.prepare();
    // 磁盘流式资源：迁移前显式走"只写头"的分支，现在同样不能为 HEAD 读整个文件
    const res = await app.inject({
      method: "HEAD",
      url: `/remote/v4/latest/assets/${CHUNK_NAME}`,
    });
    assertEquals(res.statusCode, 200);
    assertEquals(Number(header(res, "content-length")), CHUNK_CONTENT.length);
    assertEquals(res.body, "");
    assertMatch(header(res, "content-type"), /javascript/);
  });
});

Deno.test("HEAD 对压缩表示给出压缩后的长度", async () => {
  await withFixture(async ({ app, provider }) => {
    await provider.prepare();
    const res = await app.inject({
      method: "HEAD",
      url: `/remote/v4/latest/assets/${BIG_CHUNK_NAME}`,
      headers: { "accept-encoding": "br" },
    });
    assertEquals(res.statusCode, 200);
    assertEquals(header(res, "content-encoding"), "br");
    const length = Number(header(res, "content-length"));
    assert(length > 0 && length < BIG_CHUNK_CONTENT.length, `长度应是压缩后的: ${length}`);
    assertEquals(res.body, "");
  });
});

Deno.test("缺失资源返回 404 且不误回外壳", async () => {
  await withFixture(async ({ app, provider }) => {
    await provider.prepare();
    const res = await app.inject({ url: "/remote/v4/latest/assets/nope-Z.js" });
    assertEquals(res.statusCode, 404);
    assert(!res.body.includes(ENTRY_NAME), "不得把外壳当作资源返回");
  });
});

Deno.test("/remote/v4 下的未知路径走 SPA fallback", async () => {
  await withFixture(async ({ app }) => {
    const res = await app.inject({ url: "/remote/v4/some/deep/route" });
    assertEquals(res.statusCode, 200);
    assertMatch(res.body, /index-AAA111\.js/);
  });
});

Deno.test("前缀之外的路径返回 404", async () => {
  await withFixture(async ({ app }) => {
    for (const path of ["/other", "/index.html"]) {
      const res = await app.inject({ url: path });
      assertEquals(res.statusCode, 404, `${path} 应为 404`);
    }
  });
});

Deno.test("路径穿越不会泄露文件", async () => {
  await withFixture(async ({ app, provider }) => {
    await provider.prepare();
    for (
      const path of [
        "/remote/v4/latest/../../../../etc/passwd",
        "/remote/v4/latest/%2e%2e%2f%2e%2e%2fetc%2fpasswd",
        "/remote/v4/latest/....//....//etc/passwd",
        "/remote/v4/latest/assets/..%2f..%2f..%2fetc%2fpasswd",
      ]
    ) {
      const res = await app.inject({ url: path });
      const body = res.body;

      // 关键断言：绝不泄露宿主机文件
      assert(!body.includes("root:"), `${path} 不得泄露 /etc/passwd`);
      assert(!body.includes("[extensions]"), `${path} 不得泄露 /etc/passwd`);

      // 200（SPA fallback 返回外壳）、403、404 都是可接受的；
      // 不可接受的是 500 之类的异常状态
      assert(
        [200, 403, 404].includes(res.statusCode),
        `${path} 状态码异常: ${String(res.statusCode)}`,
      );
    }
  });
});

Deno.test("穿越尝试的两种结局都不泄露文件", async () => {
  await withFixture(async ({ app, provider }) => {
    await provider.prepare();
    // 字面 ../.. 在判定前就按 URL 语义折叠掉了，于是落进 SPA fallback
    // （返回外壳）。这是第一层防护。
    const collapsed = await app.inject({ url: "/remote/v4/latest/assets/../../index.html" });
    assert(!collapsed.body.includes("lead=function"), "不得返回宿主机文件");
    assertStringIncludes(collapsed.body, ENTRY_NAME, "折叠后应落到外壳");

    // 百分号编码的 %2f 不是路径分隔符，因此仍留在 assets/ 前缀内，
    // 交给文件解析器处理并因不存在而失败。这是第二层防护。
    const encoded = await app.inject({ url: "/remote/v4/latest/assets/..%2f..%2findex.html" });
    assertEquals(encoded.statusCode, 404);
    assert(!encoded.body.includes("lead=function"), "不得返回宿主机文件");
  });
});

Deno.test("非 GET/HEAD 方法返回 405", async () => {
  await withFixture(async ({ app }) => {
    const res = await app.inject({
      method: "POST",
      url: `/remote/v4/latest/assets/${CHUNK_NAME}`,
    });
    assertEquals(res.statusCode, 405);
    assertEquals(header(res, "allow"), "GET, HEAD");
  });
});

// ---------- 内容协商与压缩 ----------
//
// 用 inject（而不是 fetch）：fetch 会自动解压，看不到"服务端真的发了 br"
// 以及压缩后的字节数。

Deno.test("可压缩资源在客户端接受 br 时返回 br", async () => {
  await withFixture(async ({ app, provider }) => {
    await provider.prepare();
    const res = await app.inject({
      url: `/remote/v4/latest/assets/${BIG_CHUNK_NAME}`,
      headers: { "accept-encoding": "gzip, deflate, br" },
    });

    assertEquals(res.statusCode, 200);
    assertEquals(header(res, "content-encoding"), "br");
    assertEquals(header(res, "vary"), "Accept-Encoding");
    assertEquals(
      Number(header(res, "content-length")),
      res.rawPayload.byteLength,
      "长度须是压缩后的长度",
    );
    assert(res.rawPayload.byteLength < BIG_CHUNK_CONTENT.length, "压缩后应更小");
    assertEquals(utf8(new Uint8Array(brotliDecompressSync(res.rawPayload))), BIG_CHUNK_CONTENT);
  });
});

Deno.test("只接受 gzip 时用 gzip", async () => {
  await withFixture(async ({ app, provider }) => {
    await provider.prepare();
    const res = await app.inject({
      url: `/remote/v4/latest/assets/${BIG_CHUNK_NAME}`,
      headers: { "accept-encoding": "gzip, deflate" },
    });
    assertEquals(header(res, "content-encoding"), "gzip");
    assertEquals(utf8(new Uint8Array(gunzipSync(res.rawPayload))), BIG_CHUNK_CONTENT);
  });
});

Deno.test("不接受任何编码时发原文，但仍声明 Vary", async () => {
  await withFixture(async ({ app, provider }) => {
    await provider.prepare();
    const res = await app.inject({
      url: `/remote/v4/latest/assets/${BIG_CHUNK_NAME}`,
      headers: { "accept-encoding": "identity" },
    });
    assertEquals(res.headers["content-encoding"], undefined);
    assertEquals(
      header(res, "vary"),
      "Accept-Encoding",
      "缺了 Vary，共享缓存会把这份原文回给明确要求 br 的客户端",
    );
    assertEquals(res.body, BIG_CHUNK_CONTENT);
  });
});

Deno.test("已压缩格式不做二次压缩", async () => {
  await withFixture(async ({ app, provider }) => {
    await provider.prepare();
    const res = await app.inject({
      url: `/remote/v4/latest/assets/${PNG_NAME}`,
      headers: { "accept-encoding": "br" },
    });
    assertEquals(res.statusCode, 200);
    // 夹具内容是全零、压缩比极高；若按"可压性"判断就会误压，故这里验的是按扩展名判断
    assertEquals(res.headers["content-encoding"], undefined, "PNG 不该被压缩");
    assertEquals(res.headers["vary"], undefined, "不会被压的资源无需声明 Vary");
  });
});

Deno.test("小于阈值的资源不压", async () => {
  await withFixture(async ({ app, provider }) => {
    await provider.prepare();
    const res = await app.inject({
      url: `/remote/v4/latest/assets/${CHUNK_NAME}`,
      headers: { "accept-encoding": "br" },
    });
    assertEquals(header(res, "content-encoding"), "", "几百字节的资源压了可能更大");
  });
});

Deno.test("br 表示有自己的校验符，用它协商回 304", async () => {
  await withFixture(async ({ app, provider }) => {
    await provider.prepare();
    const br = await app.inject({
      url: `/remote/v4/latest/assets/${BIG_CHUNK_NAME}`,
      headers: { "accept-encoding": "br" },
    });
    const etag = header(br, "etag");
    assert(etag, "压缩表示也应有校验符");

    const again = await app.inject({
      url: `/remote/v4/latest/assets/${BIG_CHUNK_NAME}`,
      headers: { "accept-encoding": "br", "if-none-match": etag },
    });
    assertEquals(again.statusCode, 304);
    assertEquals(again.rawPayload.byteLength, 0);
    assertEquals(header(again, "vary"), "Accept-Encoding");
  });
});

Deno.test("外壳（内存路径）同样按编码协商，且各有自己的校验符", async () => {
  await withFixture(async ({ app }) => {
    const identity = await app.inject({
      url: "/remote/v4/latest/",
      headers: { "accept-encoding": "identity" },
    });
    const br = await app.inject({
      url: "/remote/v4/latest/",
      headers: { "accept-encoding": "br" },
    });

    assertEquals(identity.headers["content-encoding"], undefined);
    assertEquals(header(br, "content-encoding"), "br");
    assert(br.rawPayload.byteLength < identity.rawPayload.byteLength);
    assertNotEquals(
      header(br, "etag"),
      header(identity, "etag"),
      "br 与 identity 是不同表示，强校验符必须不同，否则 304 会串表示",
    );

    const again = await app.inject({
      url: "/remote/v4/latest/",
      headers: { "accept-encoding": "br", "if-none-match": header(br, "etag") },
    });
    assertEquals(again.statusCode, 304);
  });
});
