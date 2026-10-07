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
import { join, normalize, resolve, sep, extname } from "node:path";
import type { IncomingMessage, ServerResponse } from "node:http";

import type { Logger } from "../relay/relay.ts";
import { applyRelayPatch, inspectAnchors } from "../tools/patch-spa.ts";

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
 * 缓存策略。注意入口 bundle 被 patch 后**内容已与其文件名中的哈希不符**，
 * 所以不能再用 immutable——否则浏览器会把打过补丁的版本钉住一年，
 * 将来换 relay 地址时无法更新。
 */
function cacheControlFor(relativePath: string, isPatchedEntry: boolean): string {
  if (relativePath === "index.html") return "no-cache, no-store, must-revalidate";
  if (isPatchedEntry) return "no-store";
  return "public, max-age=31536000, immutable";
}

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
  #shellBytes: Buffer | null = null;
  #entryName: string | null = null;
  /** 内存中的 patched 入口 bundle。磁盘上的原文件不动。 */
  #patchedEntry: Buffer | null = null;

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
    const shell = await this.#buildShell();
    this.#shellBytes = shell;
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
    this.#patchedEntry = Buffer.from(patched, "utf8");
    return {
      shellBytes: shell.length,
      entryBundle: entry,
      patch: "applied",
      detail:
        `内存 overlay：${String(Buffer.byteLength(source, "utf8"))} → ` +
        `${String(this.#patchedEntry.length)} 字节（磁盘文件未改动）`,
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

  /** 外壳内容（已注入 relay 地址）。 */
  async shell(): Promise<Buffer> {
    this.#shellBytes ??= await this.#buildShell();
    return this.#shellBytes;
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
      await this.#sendBuffer(res, "index.html", await this.shell());
      return;
    }

    // 资源。剥掉 /remote/v4/latest/ 之后相对路径**保留** assets/ 段，
    // 因为磁盘布局就是 <root>/assets/<name>。
    const relative = pathname.startsWith(LATEST_PREFIX)
      ? pathname.slice(LATEST_PREFIX.length)
      : null;

    if (relative !== null && relative === "") {
      await this.#sendBuffer(res, "index.html", await this.shell());
      return;
    }

    // 入口 bundle：送出内存中的 patched 版本
    if (
      relative !== null &&
      this.#entryName !== null &&
      relative === `${ASSETS_DIR_SEGMENT}${this.#entryName}` &&
      this.#patchedEntry !== null
    ) {
      await this.#sendBuffer(res, relative, this.#patchedEntry, true);
      return;
    }

    // 不是 /remote/v4/latest/ 下的路径 → SPA fallback（应用路由）
    if (relative === null) {
      await this.#sendBuffer(res, "index.html", await this.shell());
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
      await this.#sendBuffer(res, "index.html", await this.shell());
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

    res.writeHead(200, {
      "content-type": contentTypeFor(relative),
      "content-length": String(info.size),
      "cache-control": cacheControlFor(relative, false),
      "x-content-type-options": "nosniff",
    });
    if (req.method === "HEAD") {
      res.end();
      return;
    }
    await new Promise<void>((done) => {
      const stream = createReadStream(absolute);
      stream.on("error", () => {
        res.destroy();
        done();
      });
      stream.on("end", done);
      stream.pipe(res);
    });
  }

  #status(res: ServerResponse): void {
    const patchState =
      this.#patchedEntry !== null
        ? `已套用（内存 overlay，磁盘未改动）→ ${String(this.#patchedEntry.length)} 字节`
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

  async #sendBuffer(
    res: ServerResponse,
    relative: string,
    body: Buffer,
    isPatchedEntry = false,
  ): Promise<void> {
    res.writeHead(200, {
      "content-type": contentTypeFor(relative),
      "content-length": String(body.length),
      "cache-control": cacheControlFor(relative, isPatchedEntry),
      "x-content-type-options": "nosniff",
    });
    res.end(body);
  }
}
