/**
 * SPA 资源托管。见 docs/design.md §3 的 asset-server 模块。
 *
 * 路由（与厂商站的路径保持一致，因为 SPA 内部用的是绝对路径引用）：
 *   /                         状态页（便于确认服务在跑）
 *   /remote/v4                配对链接的落点 → 外壳
 *   /remote/v4/               同上
 *   /remote/v4/latest/        外壳
 *   /remote/v4/latest/<path>  具体资源
 *
 * 之所以必须在**同一个源**的**精确路径**下提供资源：外壳里的 worker、
 * PNG、MP3 用的是绝对路径 `/remote/v4/latest/assets/...`，且 ES module
 * 语义依赖同源。见 docs/patching.md §4。
 *
 * 两类运行时改写，都在内存里完成，**磁盘上的厂商资源保持原样**：
 *   1. 外壳注入 relay 地址的 meta 标签
 *   2. 入口 bundle 套用 relay patch
 *
 * 这样 vendor-assets/ 始终是厂商资源的忠实镜像，manifest.json 里的 sha256
 * 始终可校验，重新抓取也不会与 patch 打架。
 */

import { createReadStream } from "node:fs";
import { readdir, readFile, stat } from "node:fs/promises";
import { pipeline } from "node:stream";
import { join, normalize, resolve, sep, extname } from "node:path";
import type { IncomingMessage, ServerResponse } from "node:http";

import type { Logger } from "../relay/relay.ts";
import { applyRelayPatch, inspectAnchors } from "../tools/patch-spa.ts";
import {
  CompressedCache,
  isCompressible,
  negotiateEncoding,
  VariantStore,
  variantFor,
  type ContentEncoding,
  type Variant,
} from "./encoding.ts";
import { etagMatches } from "./validators.ts";

const LOG_PREFIX = "/remote/v4";
const LATEST_PREFIX = `${LOG_PREFIX}/latest/`;
/** 磁盘布局里资源所在的子目录段。 */
const ASSETS_DIR_SEGMENT = "assets/";
const ASSETS_PREFIX = `${LATEST_PREFIX}${ASSETS_DIR_SEGMENT}`;

/** 外壳的入口路径。 */
const SHELL_PATHS = new Set([
  "/remote/v4",
  "/remote/v4/",
  "/remote/v4/latest",
  "/remote/v4/latest/",
]);

/** 入口 bundle 的形状：assets/index-<hash>.js */
const ENTRY_BUNDLE = /^index-[A-Za-z0-9_-]+\.js$/;

const CONTENT_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".map": "application/json; charset=utf-8",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".gif": "image/gif",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
  ".mp3": "audio/mpeg",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".ttf": "font/ttf",
  ".wasm": "application/wasm",
  ".txt": "text/plain; charset=utf-8",
};

function contentTypeFor(path: string): string {
  return CONTENT_TYPES[extname(path).toLowerCase()] ?? "application/octet-stream";
}

/**
 * 需要每次回源校验的两类响应：外壳（内嵌 relay 地址）与入口 bundle。
 *
 * no-cache 与 no-store 的区别是这条策略的关键：no-store 禁止浏览器留副本，
 * 于是每次页面加载都要重下整个入口（实测 4.6 MiB）；no-cache 允许留副本，
 * 只要求复用前回源问一次。配合下方 ETag，未变时回 304，重复访问的流量
 * 从整个入口降到一次条件请求。
 *
 * 入口**不能**用 immutable——补丁后内容已与文件名中的哈希不符，允许无条件
 * 复用会把旧 relay 地址钉死一年。no-cache 恰好保留了这种可更新性：
 * 补丁后的字节一变，ETag 就变，浏览器立刻拿到新版本。
 */
const CACHE_REVALIDATE = "no-cache";

/** 文件名内含内容哈希、故内容与文件名必然一致：可长期无条件缓存。 */
const CACHE_IMMUTABLE = "public, max-age=31536000, immutable";

/**
 * 压缩产物缓存上限。整棵树的压缩产物约 15 MiB，故实际效果是"全缓存"；
 * 这道上限只为防将来资源变大时内存无界增长。
 */
const COMPRESSED_CACHE_BYTES = 32 * 1024 * 1024;

export interface AssetServerOptions {
  /** 抓取所得的厂商资源根目录。本服务不会写它。 */
  readonly rootDir: string;
  /**
   * relay 的 WebSocket 地址。提供后会在服务外壳时注入
   * `<meta name="zcode-relay-ws">`，部署方无需手改 HTML。
   */
  readonly relayUrl?: string | undefined;
  /**
   * 是否在服务入口 bundle 时于内存中套用 relay patch。默认 true。
   * 关闭后入口 bundle 原样送出，SPA 会连回厂商 relay。
   */
  readonly patchEntryBundle?: boolean | undefined;
  readonly logger?: Logger;
}

/** 属性值转义，避免 URL 里的特殊字符破坏 HTML。 */
function escapeAttribute(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

/**
 * 把 relay 地址注入外壳。插在 `<head>` 之后，尽量靠前，
 * 使 SPA 首次读取 B4t() 时 meta 已就绪。
 */
export function injectRelayMeta(html: string, relayUrl: string): string {
  const tag = `<meta name="zcode-relay-ws" content="${escapeAttribute(relayUrl)}">`;
  const headIndex = html.search(/<head[^>]*>/i);
  if (headIndex < 0) throw new Error("外壳中没有找到 <head>，无法注入 relay 地址");
  const insertAt = headIndex + html.slice(headIndex).indexOf(">") + 1;
  return `${html.slice(0, insertAt)}\n    ${tag}${html.slice(insertAt)}`;
}

/** 从外壳里找入口 bundle 名。找不到返回 null。 */
export function findEntryBundle(html: string): string | null {
  const pattern = new RegExp(`${ASSETS_PREFIX.replace(/\//g, "\\/")}(index-[A-Za-z0-9_-]+\\.js)`, "g");
  for (const match of html.matchAll(pattern)) {
    const name = match[1];
    if (name !== undefined && ENTRY_BUNDLE.test(name)) return name;
  }
  return null;
}

export interface PrepareReport {
  readonly shellBytes: number;
  readonly entryBundle: string | null;
  readonly patch: "applied" | "already-patched" | "disabled" | "failed";
  readonly detail: string;
}

export class AssetServer {
  readonly #root: string;
  readonly #log: Logger;
  readonly #relayUrl: string | undefined;
  readonly #patchEntry: boolean;
  /** 外壳（已注入 relay 地址）的各编码变体。 */
  #shell: VariantStore | null = null;
  #entryName: string | null = null;
  /**
   * 内存中的 patched 入口 bundle 及其变体，磁盘上的原文件不动。
   * 字节与校验符同生同灭，故合成一个对象——分开存会出现
   * "有字节没指纹"的中间态。
   */
  #patched: VariantStore | null = null;
  /** 磁盘资源的压缩产物缓存。 */
  readonly #compressed = new CompressedCache(COMPRESSED_CACHE_BYTES);

  constructor(options: AssetServerOptions) {
    this.#root = resolve(options.rootDir);
    this.#relayUrl = options.relayUrl;
    this.#patchEntry = options.patchEntryBundle !== false;
    const noop: Logger = { info: () => {}, warn: () => {} };
    this.#log = options.logger ?? noop;
  }

  /**
   * 预检：解析外壳、定位入口 bundle、校验并预生成 patched 版本。
   * 必须在开始接受请求之前调用——anchor 不匹配时应当拒绝启动，
   * 而不是静默送出未 patch 的 bundle（那会让 SPA 悄悄连回厂商 relay）。
   */
  async prepare(): Promise<PrepareReport> {
    const shellStore = await this.#shellStore();
    // 预热 br：外壳与入口都在首屏关键路径上，把压缩成本挪到接受请求之前。
    await shellStore.warm("br");
    const shell = shellStore.identity.body;
    const html = shell.toString("utf8");

    const entry = findEntryBundle(html) ?? (await this.#scanForEntry());
    if (entry === null) {
      return {
        shellBytes: shell.length,
        entryBundle: null,
        patch: "failed",
        detail: "外壳与资源目录里都没有找到 index-<hash>.js 入口 bundle",
      };
    }
    this.#entryName = entry;

    if (!this.#patchEntry) {
      return {
        shellBytes: shell.length,
        entryBundle: entry,
        patch: "disabled",
        detail: "入口 patch 已关闭，SPA 将连回厂商 relay",
      };
    }

    const source = await readFile(join(this.#root, "assets", entry), "utf8");
    const anchors = inspectAnchors(source);

    if (anchors.alreadyPatched) {
      return {
        shellBytes: shell.length,
        entryBundle: entry,
        patch: "already-patched",
        detail: "磁盘上的入口 bundle 已被 patch 过，将原样送出",
      };
    }

    if (!anchors.patchable) {
      return {
        shellBytes: shell.length,
        entryBundle: entry,
        patch: "failed",
        detail:
          `patch 锚点不匹配（overrideUrl:void 0 出现 ${String(anchors.overrideCount)} 次，` +
          `上下文锚点出现 ${String(anchors.functionCount)} 次，均应为 1）。` +
          `厂商构建可能已变化，见 docs/patching.md §5。`,
      };
    }

    const patched = applyRelayPatch(source);
    const store = new VariantStore(Buffer.from(patched, "utf8"), true);
    await store.warm("br");
    this.#patched = store;
    return {
      shellBytes: shell.length,
      entryBundle: entry,
      patch: "applied",
      detail:
        `内存 overlay：${String(Buffer.byteLength(source, "utf8"))} → ` +
        `${String(store.identity.body.length)} 字节（磁盘文件未改动）`,
    };
  }

  /** 外壳与资源目录都没找到时，扫描目录兜底。 */
  async #scanForEntry(): Promise<string | null> {
    try {
      const names = await readdir(join(this.#root, "assets"));
      const candidates = names.filter((n) => ENTRY_BUNDLE.test(n)).sort();
      return candidates[0] ?? null;
    } catch {
      return null;
    }
  }

  async #buildShell(): Promise<Buffer> {
    const raw = await readFile(join(this.#root, "index.html"));
    if (this.#relayUrl === undefined) return raw;
    return Buffer.from(injectRelayMeta(raw.toString("utf8"), this.#relayUrl), "utf8");
  }

  /**
   * 外壳的变体集合。构建一次并缓存，请求路径上不重算哈希、不重复压缩。
   * 外壳内嵌 relay 地址，故不可压性不适用——它总是文本，值得压。
   */
  async #shellStore(): Promise<VariantStore> {
    const cached = this.#shell;
    if (cached !== null) return cached;
    const store = new VariantStore(await this.#buildShell(), true);
    this.#shell = store;
    return store;
  }

  /** 外壳内容（已注入 relay 地址）。 */
  async shell(): Promise<Buffer> {
    return (await this.#shellStore()).identity.body;
  }

  /**
   * 请求的路径是否为入口 bundle（`assets/index-<hash>.js`）。
   *
   * 按文件名形状判断，而不比对 prepare() 探到的那个具体名字：这条不变量
   * （入口一律回源校验）不应当依赖 prepare() 是否跑过。厂商构建只会产出
   * 一个入口，即便这里有误判，代价也只是一次条件请求而非缓存命中。
   */
  #isEntryPath(relative: string): boolean {
    if (!relative.startsWith(ASSETS_DIR_SEGMENT)) return false;
    return ENTRY_BUNDLE.test(relative.slice(ASSETS_DIR_SEGMENT.length));
  }

  /**
   * 把 URL 路径映射到磁盘相对路径。
   * 返回 null 表示应走外壳（SPA fallback）；抛错表示越界访问。
   */
  #resolve(relativeUrlPath: string): string | null {
    const normalized = normalize(relativeUrlPath).replace(/^(\.\.(\/|\\|$))+/, "");
    const absolute = resolve(join(this.#root, normalized));
    if (absolute !== this.#root && !absolute.startsWith(this.#root + sep)) {
      throw new Error("path escapes asset root");
    }
    if (normalized === "" || normalized === "." || normalized === "index.html") return null;
    return absolute;
  }

  /** 生成 HTTP 请求处理器。 */
  handler(): (req: IncomingMessage, res: ServerResponse) => void {
    return (req, res) => {
      void this.#handle(req, res).catch((err: unknown) => {
        const message = err instanceof Error ? err.message : String(err);
        this.#log.warn("asset request failed", { url: req.url, error: message });
        if (!res.headersSent) {
          res.writeHead(500, { "content-type": "text/plain; charset=utf-8" });
        }
        res.end("internal error");
      });
    };
  }

  async #handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (req.method !== "GET" && req.method !== "HEAD") {
      res.writeHead(405, { allow: "GET, HEAD" });
      res.end();
      return;
    }

    const rawUrl = req.url ?? "/";
    let pathname: string;
    try {
      pathname = new URL(rawUrl, "http://assets.invalid").pathname;
    } catch {
      res.writeHead(400).end();
      return;
    }

    if (pathname === "/" || pathname === "/healthz") {
      this.#status(res);
      return;
    }

    if (!pathname.startsWith(LOG_PREFIX)) {
      res.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
      res.end("not found");
      return;
    }

    if (SHELL_PATHS.has(pathname)) {
      await this.#sendShell(req, res);
      return;
    }

    // 资源。剥掉 /remote/v4/latest/ 之后相对路径**保留** assets/ 段，
    // 因为磁盘布局就是 <root>/assets/<name>。
    const relative = pathname.startsWith(LATEST_PREFIX)
      ? pathname.slice(LATEST_PREFIX.length)
      : null;

    if (relative !== null && relative === "") {
      await this.#sendShell(req, res);
      return;
    }

    // 入口 bundle：送出内存中的 patched 版本
    const patched = this.#patched;
    if (relative !== null && this.#isEntryPath(relative) && patched !== null) {
      const variant = await patched.select(negotiateEncoding(req.headers["accept-encoding"]));
      await this.#sendBuffer(req, res, relative, variant, CACHE_REVALIDATE, true);
      return;
    }

    // 不是 /remote/v4/latest/ 下的路径 → SPA fallback（应用路由）
    if (relative === null) {
      await this.#sendShell(req, res);
      return;
    }

    let absolute: string | null;
    try {
      absolute = this.#resolve(relative);
    } catch {
      res.writeHead(403, { "content-type": "text/plain; charset=utf-8" });
      res.end("forbidden");
      return;
    }

    if (absolute === null) {
      await this.#sendShell(req, res);
      return;
    }

    let info;
    try {
      info = await stat(absolute);
    } catch {
      this.#log.warn("asset not found", { path: relative });
      res.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
      res.end(`asset not found: ${relative}`);
      return;
    }
    if (!info.isFile()) {
      res.writeHead(404).end();
      return;
    }

    // 走到这里说明入口没有内存 overlay（patch 关闭，或磁盘上已被 patch）。
    // 后者内容同样与文件名哈希不符，故入口路径一律要求回源校验。
    const cacheControl = this.#isEntryPath(relative) ? CACHE_REVALIDATE : CACHE_IMMUTABLE;
    const compressible = isCompressible(relative, info.size);
    const encoding = compressible
      ? negotiateEncoding(req.headers["accept-encoding"])
      : "identity";

    if (encoding !== "identity") {
      await this.#sendBuffer(
        req,
        res,
        relative,
        await this.#compressedFile(absolute, relative, encoding),
        cacheControl,
        true,
      );
      return;
    }

    res.writeHead(200, {
      "content-type": contentTypeFor(relative),
      "content-length": String(info.size),
      "cache-control": cacheControl,
      // 即使这次发的是未压缩内容也要声明：否则共享缓存可能把这份原文
      // 回给一个明确要求 br 的客户端。
      ...(compressible ? { vary: "Accept-Encoding" } : {}),
      "x-content-type-options": "nosniff",
    });
    if (req.method === "HEAD") {
      res.end();
      return;
    }
    // 必须用 pipeline 而不是 pipe：客户端中途断开时 pipe 只会把源流 unpipe 并暂停，
    // 既不会 destroy 源流，也不会触发 autoClose，于是那个文件 fd 被永久持有
    // （实测每个中断请求泄漏一个，约两百次后 EMFILE）。pipeline 在任意一端
    // 结束或出错时销毁全部流，这才是核心模块里本来就有的正确原语。
    await new Promise<void>((done) => {
      pipeline(createReadStream(absolute), res, () => {
        done();
      });
    });
  }

  #status(res: ServerResponse): void {
    const patchState =
      this.#patched !== null
        ? `已套用（内存 overlay，磁盘未改动）→ ${String(this.#patched.identity.body.length)} 字节`
        : this.#entryName === null
          ? "未找到入口 bundle"
          : "未套用（入口原样送出）";
    const body = [
      "zcode-relay asset server",
      "",
      `资源根目录: ${this.#root}`,
      `入口 bundle: ${this.#entryName ?? "(未找到)"}`,
      `relay patch: ${patchState}`,
      "",
      "SPA 入口（配对链接的落点）:",
      "  /remote/v4?sid=<device_sid>&hash=<pass_hash>&t=<ts>",
      "",
      "外壳:",
      "  /remote/v4/latest/",
      "",
      "relay 端点（WebSocket，同端口）:",
      "  /ws",
      "",
    ].join("\n");
    res.writeHead(200, {
      "content-type": "text/plain; charset=utf-8",
      "content-length": String(Buffer.byteLength(body)),
    });
    res.end(body);
  }

  /**
   * 磁盘资源的压缩产物。命中缓存则零成本；否则读一次文件、异步压一次并留住。
   * 未压缩的变体不入缓存，见 `CompressedCache` 的注释。
   */
  async #compressedFile(
    absolute: string,
    relative: string,
    encoding: ContentEncoding,
  ): Promise<Variant> {
    const key = `${encoding}|${relative}`;
    const cached = this.#compressed.get(key);
    if (cached !== undefined) return cached;

    const variant = await variantFor(encoding, await readFile(absolute));
    this.#compressed.set(key, variant);
    return variant;
  }

  /** 送出外壳。四个入口路径与 SPA fallback 都走这里，协商与校验也在此统一处理。 */
  async #sendShell(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const store = await this.#shellStore();
    const variant = await store.select(negotiateEncoding(req.headers["accept-encoding"]));
    await this.#sendBuffer(req, res, "index.html", variant, CACHE_REVALIDATE, true);
  }

  /**
   * 送出内存里的某个表示，并处理条件请求。
   *
   * 命中 If-None-Match 时回 304 且不带正文——这正是 no-cache 的价值所在：
   * 浏览器留着副本，只用一次条件请求确认，无需重下整个入口 bundle。
   *
   * 校验符属于**该表示**（br 与 identity 的 ETag 不同），故必须先用协商结果
   * 选出变体、再比对指纹，顺序不能反。
   */
  async #sendBuffer(
    req: IncomingMessage,
    res: ServerResponse,
    relative: string,
    variant: Variant,
    cacheControl: string,
    vary: boolean,
  ): Promise<void> {
    const { body, encoding, etag } = variant;
    // 声明 Vary 后，共享缓存才不会把这份表示回给不接受该编码的客户端。
    const negotiated = vary ? { vary: "Accept-Encoding" } : {};

    if (etagMatches(req.headers["if-none-match"], etag)) {
      // 304 不带正文，但必须回 ETag 与 Cache-Control，
      // 否则浏览器无法把这次命中与已存的副本关联起来。
      res.writeHead(304, { etag, "cache-control": cacheControl, ...negotiated });
      res.end();
      return;
    }
    res.writeHead(200, {
      "content-type": contentTypeFor(relative),
      "content-length": String(body.length),
      "cache-control": cacheControl,
      ...(encoding === null ? {} : { "content-encoding": encoding }),
      ...negotiated,
      etag,
      "x-content-type-options": "nosniff",
    });
    res.end(body);
  }
}
