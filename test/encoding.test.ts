import { test } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";

import {
  CompressedCache,
  isCompressible,
  negotiateEncoding,
  VariantStore,
  variantFor,
} from "../src/assets/encoding.ts";

/** 可压缩的样本：比阈值大，且文本内容压缩比高。 */
const compressibleBody = (): Buffer => Buffer.from("const value = 1;\n".repeat(400), "utf8");

// ---------- 内容协商 ----------

test("浏览器给出的常见 Accept-Encoding 都优先选 br", () => {
  // Chrome / Safari / Firefox 的实际取值
  assert.equal(negotiateEncoding("gzip, deflate, br"), "br");
  assert.equal(negotiateEncoding("gzip, deflate, br, zstd"), "br");
  assert.equal(negotiateEncoding("br"), "br");
});

test("不支持 br 时退回 gzip", () => {
  assert.equal(negotiateEncoding("gzip, deflate"), "gzip");
  assert.equal(negotiateEncoding("gzip;q=1, br;q=0"), "gzip", "q=0 表示明确拒绝");
});

test("按 q 值排序，同值时才偏好 br", () => {
  assert.equal(negotiateEncoding("br;q=0.8, gzip;q=0.9"), "gzip");
  assert.equal(negotiateEncoding("br;q=1.0, gzip;q=1.0"), "br");
});

test("通配符为未列出的编码提供默认值", () => {
  assert.equal(negotiateEncoding("*"), "br");
  assert.equal(negotiateEncoding("gzip;q=0.5, *;q=0.9"), "br");
  assert.equal(negotiateEncoding("br;q=0, *"), "gzip");
});

test("不接受任何编码时回 identity 而不是报错", () => {
  // 回未压缩内容永远是正确的；406 会让 SPA 加载失败，属于硬故障
  assert.equal(negotiateEncoding(undefined), "identity");
  assert.equal(negotiateEncoding(""), "identity");
  assert.equal(negotiateEncoding("identity"), "identity");
  assert.equal(negotiateEncoding("br;q=0, gzip;q=0"), "identity");
  assert.equal(negotiateEncoding("deflate"), "identity", "deflate 不在支持范围内");
});

test("Accept-Encoding 为数组时同样解析", () => {
  assert.equal(negotiateEncoding(["gzip", "br"]), "br");
});

// ---------- 是否值得压 ----------

test("只压文本类且体积达标的资源", () => {
  assert.equal(isCompressible("assets/index-abc.js", 5000), true);
  assert.equal(isCompressible("assets/style.css", 5000), true);

  // 本身已是压缩格式，再压是白烧 CPU
  assert.equal(isCompressible("assets/logo.png", 5000), false);
  assert.equal(isCompressible("assets/sound.mp3", 5000), false);
  assert.equal(isCompressible("assets/font.woff2", 5000), false);
  // 二进制且单文件可达 4 MiB，跳过
  assert.equal(isCompressible("assets/duke.wasm", 4 * 1024 * 1024), false);

  // 树里约两千个几百字节的图标 chunk 由阈值挡住
  assert.equal(isCompressible("assets/icon-a.js", 300), false);
});

// ---------- 变体生成 ----------

test("br 变体确实更小，且带自己的校验符", async () => {
  const body = compressibleBody();
  const identity = await variantFor("identity", body);
  const br = await variantFor("br", body);

  assert.equal(identity.encoding, null);
  assert.equal(identity.body, body, "identity 必须原样送出");

  assert.equal(br.encoding, "br");
  assert.ok(br.body.length < body.length, "应压得更小");
  assert.notEqual(br.etag, identity.etag, "不同表示的强校验符必须不同，否则 304 会串表示");
});

test("br 变体解压后与原文逐字节一致", async () => {
  const { brotliDecompressSync } = await import("node:zlib");
  const body = compressibleBody();
  const br = await variantFor("br", body);
  assert.equal(brotliDecompressSync(br.body).toString("utf8"), body.toString("utf8"));
});

test("压不小的时候退回原文而不是发更大的字节", async () => {
  // 必须用真随机字节。周期序列（如 (i*7+13)%251）看起来"杂乱"，
  // 实际重复度极高，brotli 能压掉九成以上，测不出这个分支。
  const incompressible = randomBytes(2048);

  const variant = await variantFor("br", incompressible);
  assert.equal(variant.encoding, null, "压不小就不该声称经过编码");
  assert.equal(variant.body, incompressible);
});

// ---------- 内存响应 ----------

test("VariantStore 缓存压缩结果，同一编码只压一次", async () => {
  const store = new VariantStore(compressibleBody(), true);
  const first = await store.select("br");
  const second = await store.select("br");

  assert.equal(first, second, "第二次应命中缓存，返回同一对象");
  assert.equal(first.encoding, "br");
});

test("warm 之后 select 不再付出压缩成本", async () => {
  const store = new VariantStore(compressibleBody(), true);
  await store.warm("br");

  const warmed = await store.select("br");
  // 预热过的话这里必然直接命中；用对象恒等来断言"没有重新生成"
  assert.equal(warmed, await store.select("br"));
  assert.equal(warmed.encoding, "br");
});

test("VariantStore 对不可压内容直接回原文", async () => {
  const store = new VariantStore(compressibleBody(), false);
  const variant = await store.select("br");
  assert.equal(variant, store.identity);
  assert.equal(variant.encoding, null);
});

test("VariantStore 对过小内容不压", async () => {
  const tiny = Buffer.from("x=1", "utf8");
  const store = new VariantStore(tiny, true);
  assert.equal((await store.select("br")).encoding, null);
});

// ---------- 磁盘资源的压缩缓存 ----------

test("CompressedCache 只收压缩产物", () => {
  const cache = new CompressedCache(1024);
  const identity = { body: Buffer.alloc(64), encoding: null, etag: '"a"' } as const;
  cache.set("k", identity);
  assert.equal(cache.get("k"), undefined, "未压缩的变体不入缓存，否则等于把原文留在内存里");
});

test("CompressedCache 超出字节上限时按插入序淘汰", () => {
  const cache = new CompressedCache(300);
  const variant = (fill: number): { body: Buffer; encoding: "br"; etag: string } => ({
    body: Buffer.alloc(100, fill),
    encoding: "br",
    etag: `"${String(fill)}"`,
  });

  cache.set("a", variant(1));
  cache.set("b", variant(2));
  cache.set("c", variant(3));
  cache.set("d", variant(4)); // 累计 400 > 300，最旧的 a 应被淘汰

  assert.equal(cache.get("a"), undefined, "最旧的应被淘汰");
  assert.ok(cache.get("b"));
  assert.ok(cache.get("d"));
});

test("CompressedCache 覆盖同一 key 时不重复计字节", () => {
  // 预算恰好容得下两个 100 字节条目。若覆盖时忘了先减掉旧值，
  // 累计会虚高成 300，第二次写入就会误淘汰掉 k。
  const cache = new CompressedCache(200);
  const first = { body: Buffer.alloc(100), encoding: "br", etag: '"1"' } as const;
  const second = { body: Buffer.alloc(100), encoding: "br", etag: '"2"' } as const;

  cache.set("k", first);
  cache.set("k", second);
  cache.set("other", { body: Buffer.alloc(100), encoding: "br", etag: '"3"' });

  assert.equal(cache.get("k"), second, "不该因重复计字节而被误淘汰");
  assert.ok(cache.get("other"));
});
