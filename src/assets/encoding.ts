/**
 * 内容协商与压缩。
 *
 * relay 的 WebSocket 转发与 asset server 同进程同事件循环，所以压缩一律走
 * zlib 的**异步**接口（落在 libuv 线程池里），绝不使用 `*Sync`——同步压
 * 4.6 MiB 会把这期间的所有 WS 帧转发卡住。
 *
 * 为什么是 brotli + gzip 而不是 zstd：Node 24 的 zlib 也支持 zstd，但 brotli
 * 的浏览器覆盖面更广，实测压缩率与耗时都够用（入口 4.60 MiB → 1.08 MiB / 53 ms，
 * 而同一份内容 gzip -6 是 1.23 MiB / 70 ms——gzip 更慢且更大，只作兼容兜底）。
 */

import { brotliCompress, constants as zlibConstants, gzip } from "node:zlib";
import { extname } from "node:path";

import { strongEtag } from "./validators.ts";

/** 实际送出的编码；identity 表示未压缩。 */
export type ContentEncoding = "br" | "gzip" | "identity";

/**
 * 只有文本类资源值得压。这几种占了首屏的绝大部分且压缩比最高。
 * PNG/JPEG/MP3/woff2 本身已是压缩格式，再压纯属白烧 CPU；
 * wasm 是二进制且单文件最大 4 MiB（`duke_sheets_wasm_bg`），同样跳过。
 */
const COMPRESSIBLE_EXTENSIONS = new Set([
  ".js",
  ".mjs",
  ".css",
  ".html",
  ".json",
  ".map",
  ".svg",
  ".txt",
]);

/**
 * 小于此长度不值得压：编码后的头部开销可能让体积不降反升。
 * 树里有约两千个几百字节的图标 chunk，正好被这条挡住。
 */
const MIN_COMPRESS_BYTES = 1024;

/** brotli 质量。q5 是实测拐点，q9 只再小 6% 却要三倍时间。 */
const BROTLI_QUALITY = 5;
const GZIP_LEVEL = 6;

/** 该资源是否值得压缩。 */
export function isCompressible(path: string, bytes: number): boolean {
  return bytes >= MIN_COMPRESS_BYTES && COMPRESSIBLE_EXTENSIONS.has(extname(path).toLowerCase());
}

/** 解析某个 token 在 Accept-Encoding 里的 q 值；未列出时取 `*` 的值，都没有则 0。 */
function acceptQuality(header: string, token: string): number {
  let wildcard = 0;
  for (const part of header.split(",")) {
    const [rawName, ...params] = part.split(";");
    const name = (rawName ?? "").trim().toLowerCase();
    if (name.length === 0) continue;

    let quality = 1;
    for (const param of params) {
      const matched = /^\s*q\s*=\s*([0-9]*\.?[0-9]+)\s*$/i.exec(param);
      const value = matched?.[1];
      if (value === undefined) continue;
      const parsed = Number(value);
      if (Number.isFinite(parsed)) quality = Math.min(Math.max(parsed, 0), 1);
    }

    if (name === token) return quality;
    if (name === "*") wildcard = quality;
  }
  return wildcard;
}

/**
 * 客户端接受哪种编码。只认 br 与 gzip；两者都可选时优先 br（实测更小且更快）。
 *
 * 都不接受时回 identity 而非 406：SPA 加载不了是硬故障，而发未压缩内容
 * 在任何情况下都是正确的响应。
 */
export function negotiateEncoding(header: string | string[] | undefined): ContentEncoding {
  if (header === undefined) return "identity";
  const raw = Array.isArray(header) ? header.join(",") : header;
  const brotli = acceptQuality(raw, "br");
  const gzipped = acceptQuality(raw, "gzip");
  if (brotli <= 0 && gzipped <= 0) return "identity";
  return brotli >= gzipped ? "br" : "gzip";
}

/** 同一份内容在某种编码下的表示。 */
export interface Variant {
  /** 将要送出的字节。 */
  readonly body: Buffer;
  /** null 表示未压缩。 */
  readonly encoding: "br" | "gzip" | null;
  /** 对该表示的字节取的强校验符。 */
  readonly etag: string;
}

function compressWith(encoding: "br" | "gzip", body: Buffer): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const done = (error: Error | null, result: Buffer): void => {
      if (error !== null) reject(error);
      else resolve(result);
    };
    if (encoding === "br") {
      brotliCompress(
        body,
        { params: { [zlibConstants.BROTLI_PARAM_QUALITY]: BROTLI_QUALITY } },
        done,
      );
    } else {
      gzip(body, { level: GZIP_LEVEL }, done);
    }
  });
}

/** 生成某种编码下的表示。压不小就退回原文，避免"压完更大"。 */
export async function variantFor(encoding: ContentEncoding, body: Buffer): Promise<Variant> {
  if (encoding === "identity") return { body, encoding: null, etag: strongEtag(body) };

  const compressed = await compressWith(encoding, body);
  if (compressed.length >= body.length) {
    return { body, encoding: null, etag: strongEtag(body) };
  }
  return { body: compressed, encoding, etag: strongEtag(compressed) };
}

/**
 * 内存响应的变体集合（外壳与 patched 入口）。identity 常驻，压缩变体按需生成
 * 并留住，于是每个编码只付一次压缩成本。
 */
export class VariantStore {
  readonly #identity: Variant;
  readonly #compressible: boolean;
  readonly #variants = new Map<"br" | "gzip", Variant>();

  constructor(body: Buffer, compressible: boolean) {
    this.#identity = { body, encoding: null, etag: strongEtag(body) };
    this.#compressible = compressible && body.length >= MIN_COMPRESS_BYTES;
  }

  get identity(): Variant {
    return this.#identity;
  }

  /** 取该编码下的表示；不可压或要 identity 时直接回原文。 */
  async select(encoding: ContentEncoding): Promise<Variant> {
    if (encoding === "identity" || !this.#compressible) return this.#identity;

    const cached = this.#variants.get(encoding);
    if (cached !== undefined) return cached;

    const variant = await variantFor(encoding, this.#identity.body);
    this.#variants.set(encoding, variant);
    return variant;
  }

  /**
   * 预热某个编码，把首屏关键路径上的压缩开销挪到开始接受请求之前。
   * 实测 br q5 压外壳 + 入口合计约 60 ms，付在这里最划算。
   */
  async warm(encoding: ContentEncoding): Promise<void> {
    await this.select(encoding);
  }
}

/**
 * 磁盘资源的压缩产物缓存。**只存压缩结果**——原文仍从磁盘流式送出，
 * 否则等于把整棵树读进内存。
 */
export class CompressedCache {
  readonly #maxBytes: number;
  readonly #entries = new Map<string, Variant>();
  #bytes = 0;

  constructor(maxBytes: number) {
    this.#maxBytes = maxBytes;
  }

  get(key: string): Variant | undefined {
    return this.#entries.get(key);
  }

  /** 未压缩的变体不入缓存，见类注释。 */
  set(key: string, variant: Variant): void {
    if (variant.encoding === null) return;

    const previous = this.#entries.get(key);
    if (previous !== undefined) {
      this.#bytes -= previous.body.length;
      this.#entries.delete(key);
    }

    this.#entries.set(key, variant);
    this.#bytes += variant.body.length;

    // 按插入序淘汰。这是自用的单用户 relay，不值得再为真正的 LRU 添一套簿记。
    while (this.#bytes > this.#maxBytes) {
      const oldest = this.#entries.keys().next();
      if (oldest.done === true) break;
      const evicted = this.#entries.get(oldest.value);
      this.#entries.delete(oldest.value);
      if (evicted !== undefined) this.#bytes -= evicted.body.length;
    }
  }
}
