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
 */

import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { join, normalize, resolve, sep, extname } from "node:path";
import type { IncomingMessage, ServerResponse } from "node:http";

import type { Logger } from "../relay/relay.ts";

const LOG_PREFIX = "/remote/v4";

/** 外壳的入口路径。 */
const SHELL_PATHS = new Set([
  "/remote/v4",
  "/remote/v4/",
  "/remote/v4/latest",
  "/remote/v4/latest/",
]);

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

/** 带内容哈希的文件名可长期缓存；外壳必须每次校验。 */
function cacheControlFor(relativePath: string): string {
  if (relativePath === "index.html") return "no-cache, no-store, must-revalidate";
  return "public, max-age=31536000, immutable";
}

export interface AssetServerOptions {
  /** 从厂商抓取并经 patch 后的资源根目录。 */
  readonly rootDir: string;
  /**
   * relay 的 WebSocket 地址。提供后会在服务外壳时自动注入
   * `<meta name="zcode-relay-ws">`，部署方无需手改 HTML。
   * patch 后的 SPA 正是按这个 meta 标签查找 relay 地址。
   */
  readonly relayUrl?: string | undefined;
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

export class AssetServer {
  readonly #root: string;
  readonly #log: Logger;
  readonly #relayUrl: string | undefined;
  #shellBytes: Buffer | null = null;

  constructor(options: AssetServerOptions) {
    this.#root = resolve(options.rootDir);
    this.#relayUrl = options.relayUrl;
    const noop: Logger = { info: () => {}, warn: () => {} };
    this.#log = options.logger ?? noop;
  }

  /** 外壳内容（已注入 relay 地址）。 */
  async shell(): Promise<Buffer> {
    this.#shellBytes ??= await this.#buildShell();
    return this.#shellBytes;
  }

  async #buildShell(): Promise<Buffer> {
    const { readFile } = await import("node:fs/promises");
    const raw = await readFile(join(this.#root, "index.html"));
    if (this.#relayUrl === undefined) return raw;
    return Buffer.from(injectRelayMeta(raw.toString("utf8"), this.#relayUrl), "utf8");
  }

  /**
   * 把 URL 路径映射到磁盘相对路径。
   * 返回 null 表示应走外壳（SPA fallback）；抛错表示越界访问。
   */
  #resolve(relativeUrlPath: string): string | null {
    // 规范化并拒绝穿越：解析后必须仍在 root 之内
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

    // 外壳入口
    if (SHELL_PATHS.has(pathname)) {
      await this.#sendBuffer(res, "index.html", await this.shell());
      return;
    }

    // 资源
    const relative = pathname.startsWith(`${LOG_PREFIX}/latest/`)
      ? pathname.slice(`${LOG_PREFIX}/latest/`.length)
      : null;

    if (relative === null) {
      // /remote/v4 下的未知路径 → SPA fallback
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
      "cache-control": cacheControlFor(relative),
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
    const body = [
      "zcode-relay asset server",
      "",
      `资源根目录: ${this.#root}`,
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
      "若外壳尚未抓取，先用 just fetch-assets 获取。",
      "",
    ].join("\n");
    res.writeHead(200, {
      "content-type": "text/plain; charset=utf-8",
      "content-length": String(Buffer.byteLength(body)),
    });
    res.end(body);
  }

  async #sendBuffer(res: ServerResponse, relative: string, body: Buffer): Promise<void> {
    res.writeHead(200, {
      "content-type": contentTypeFor(relative),
      "content-length": String(body.length),
      "cache-control": cacheControlFor(relative),
      "x-content-type-options": "nosniff",
    });
    res.end(body);
  }
}
