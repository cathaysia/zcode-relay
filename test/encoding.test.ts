import { assert, assertEquals, assertNotEquals, assertStrictEquals } from "@std/assert";
import { brotliDecompressSync, gunzipSync } from "node:zlib";

import {
  CompressedCache,
  isCompressible,
  negotiateEncoding,
  variantFor,
  VariantStore,
} from "../src/assets/encoding.ts";

/** 可压缩的样本：比阈值大，且文本内容压缩比高。 */
const compressibleBody = (): Uint8Array =>
  new TextEncoder().encode("const value = 1;\n".repeat(400));

const utf8 = (bytes: Uint8Array): string => new TextDecoder().decode(bytes);

// ---------- 内容协商 ----------

Deno.test("浏览器给出的常见 Accept-Encoding 都优先选 br", () => {
  // Chrome / Safari / Firefox 的实际取值
  assertEquals(negotiateEncoding("gzip, deflate, br"), "br");
  assertEquals(negotiateEncoding("gzip, deflate, br, zstd"), "br");
  assertEquals(negotiateEncoding("br"), "br");
});

Deno.test("不支持 br 时退回 gzip", () => {
  assertEquals(negotiateEncoding("gzip, deflate"), "gzip");
  assertEquals(negotiateEncoding("gzip;q=1, br;q=0"), "gzip", "q=0 表示明确拒绝");
});

Deno.test("按 q 值排序，同值时才偏好 br", () => {
  assertEquals(negotiateEncoding("br;q=0.8, gzip;q=0.9"), "gzip");
  assertEquals(negotiateEncoding("br;q=1.0, gzip;q=1.0"), "br");
});

Deno.test("通配符为未列出的编码提供默认值", () => {
  assertEquals(negotiateEncoding("*"), "br");
  assertEquals(negotiateEncoding("gzip;q=0.5, *;q=0.9"), "br");
  // 显式列出的 q=0 优先于通配符：RFC 9110 §12.5.3 规定 `*` 只匹配未列出的编码
  assertEquals(negotiateEncoding("br;q=0, *"), "gzip");
});

Deno.test("不接受任何编码时回 identity 而不是报错", () => {
  // 回未压缩内容永远是正确的；406 会让 SPA 加载失败，属于硬故障
  assertEquals(negotiateEncoding(undefined), "identity");
  assertEquals(negotiateEncoding(""), "identity");
  assertEquals(negotiateEncoding("identity"), "identity");
  assertEquals(negotiateEncoding("br;q=0, gzip;q=0"), "identity");
  assertEquals(negotiateEncoding("deflate"), "identity", "deflate 不在支持范围内");
});

Deno.test("Accept-Encoding 为数组时同样解析", () => {
  assertEquals(negotiateEncoding(["gzip", "br"]), "br");
});

// ---------- 是否值得压 ----------

Deno.test("只压文本类且体积达标的资源", () => {
  assertEquals(isCompressible("assets/index-abc.js", 5000), true);
  assertEquals(isCompressible("assets/style.css", 5000), true);

  // 本身已是压缩格式，再压是白烧 CPU
  assertEquals(isCompressible("assets/logo.png", 5000), false);
  assertEquals(isCompressible("assets/sound.mp3", 5000), false);
  assertEquals(isCompressible("assets/font.woff2", 5000), false);
  // 二进制且单文件可达 4 MiB，跳过
  assertEquals(isCompressible("assets/duke.wasm", 4 * 1024 * 1024), false);

  // 树里约两千个几百字节的图标 chunk 由阈值挡住
  assertEquals(isCompressible("assets/icon-a.js", 300), false);
});

// ---------- 变体生成 ----------

Deno.test("br 变体确实更小，且带自己的校验符", async () => {
  const body = compressibleBody();
  const identity = await variantFor("identity", body);
  const br = await variantFor("br", body);

  assertEquals(identity.encoding, null);
  assertStrictEquals(identity.body, body, "identity 必须原样送出，不得复制");

  assertEquals(br.encoding, "br");
  assert(br.body.length < body.length, "应压得更小");
  assertNotEquals(br.etag, identity.etag, "不同表示的强校验符必须不同，否则 304 会串表示");
});

Deno.test("br 变体解压后与原文逐字节一致", async () => {
  const body = compressibleBody();
  const br = await variantFor("br", body);
  assertEquals(utf8(new Uint8Array(brotliDecompressSync(br.body))), utf8(body));
});

Deno.test("gzip 变体解压后与原文逐字节一致", async () => {
  const body = compressibleBody();
  const gzipped = await variantFor("gzip", body);
  assertEquals(gzipped.encoding, "gzip");
  assertEquals(utf8(new Uint8Array(gunzipSync(gzipped.body))), utf8(body));
});

Deno.test("压不小的时候退回原文而不是发更大的字节", async () => {
  // 必须用真随机字节。周期序列（如 (i*7+13)%251）看起来"杂乱"，
  // 实际重复度极高，brotli 能压掉九成以上，测不出这个分支。
  const incompressible = crypto.getRandomValues(new Uint8Array(2048));

  const variant = await variantFor("br", incompressible);
  assertEquals(variant.encoding, null, "压不小就不该声称经过编码");
  assertStrictEquals(variant.body, incompressible);
});

// ---------- 内存响应 ----------

Deno.test("VariantStore 缓存压缩结果，同一编码只压一次", async () => {
  const store = await VariantStore.create(compressibleBody(), true);
  const first = await store.select("br");
  const second = await store.select("br");

  assertStrictEquals(first, second, "第二次应命中缓存，返回同一对象");
  assertEquals(first.encoding, "br");
});

Deno.test("warm 之后 select 不再付出压缩成本", async () => {
  const store = await VariantStore.create(compressibleBody(), true);
  await store.warm("br");

  const warmed = await store.select("br");
  // 预热过的话这里必然直接命中；用对象恒等来断言"没有重新生成"
  assertStrictEquals(warmed, await store.select("br"));
  assertEquals(warmed.encoding, "br");
});

Deno.test("VariantStore 对不可压内容直接回原文", async () => {
  const store = await VariantStore.create(compressibleBody(), false);
  const variant = await store.select("br");
  assertStrictEquals(variant, store.identity);
  assertEquals(variant.encoding, null);
});

Deno.test("VariantStore 对过小内容不压", async () => {
  const tiny = new TextEncoder().encode("x=1");
  const store = await VariantStore.create(tiny, true);
  assertEquals((await store.select("br")).encoding, null);
});

Deno.test("VariantStore 的 identity 变体自带校验符", async () => {
  const body = compressibleBody();
  const store = await VariantStore.create(body, true);
  assertEquals(store.identity.body, body);
  assertEquals(store.identity.encoding, null);
  assert(store.identity.etag.startsWith('"') && store.identity.etag.endsWith('"'));
});

// ---------- 磁盘资源的压缩缓存 ----------

Deno.test("CompressedCache 只收压缩产物", () => {
  const cache = new CompressedCache(1024);
  const identity = { body: new Uint8Array(64), encoding: null, etag: '"a"' } as const;
  cache.set("k", identity);
  assertEquals(cache.get("k"), undefined, "未压缩的变体不入缓存，否则等于把原文留在内存里");
});

Deno.test("CompressedCache 超出字节上限时按插入序淘汰", () => {
  const cache = new CompressedCache(300);
  const variant = (fill: number): { body: Uint8Array; encoding: "br"; etag: string } => ({
    body: new Uint8Array(100).fill(fill),
    encoding: "br",
    etag: `"${String(fill)}"`,
  });

  cache.set("a", variant(1));
  cache.set("b", variant(2));
  cache.set("c", variant(3));
  cache.set("d", variant(4)); // 累计 400 > 300，最旧的 a 应被淘汰

  assertEquals(cache.get("a"), undefined, "最旧的应被淘汰");
  assert(cache.get("b"));
  assert(cache.get("d"));
});

Deno.test("CompressedCache 覆盖同一 key 时不重复计字节", () => {
  // 预算恰好容得下两个 100 字节条目。若覆盖时忘了先减掉旧值，
  // 累计会虚高成 300，第二次写入就会误淘汰掉 k。
  const cache = new CompressedCache(200);
  const first = { body: new Uint8Array(100), encoding: "br", etag: '"1"' } as const;
  const second = { body: new Uint8Array(100), encoding: "br", etag: '"2"' } as const;

  cache.set("k", first);
  cache.set("k", second);
  cache.set("other", { body: new Uint8Array(100), encoding: "br", etag: '"3"' });

  assertStrictEquals(cache.get("k"), second, "不该因重复计字节而被误淘汰");
  assert(cache.get("other"));
});
