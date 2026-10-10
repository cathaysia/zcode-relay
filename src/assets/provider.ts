/**
 * SPA 资源托管：状态与策略（design.md §3 的 `asset-provider` 模块）。
 *
 * 这里不含 HTTP 机制——路由、方法分派、HEAD、404/405、流式响应、内容协商
 * 与 ETag 都交给 Hono（中间件，见 src/assets/routes.ts）。本文件只回答
 * "该发哪份字节、以及它该带什么缓存语义"：入口 bundle 的内存 overlay、
 * 路径越界判定、按资源类的缓存策略。
 *
 * 两类运行时改写，都在内存里完成，**磁盘上的厂商资源保持原样**：
 *   1. 外壳注入 relay 地址的 meta 标签
 *   2. 入口 bundle 套用 relay patch
 *
 * 这样 vendor-assets/ 始终是厂商资源的忠实镜像，manifest.json 里的 sha256
 * 始终可校验，重新抓取也不会与 patch 打架。
 */

// 磁盘路径一律走 posix 变体：本 relay 只支持 macOS/Linux（见 src/platform.ts），
// 而 URL 路径本来就是 posix 语义，混用平台变体只会让两套语义打架。
import * as posix from "@std/path/posix";

import type { Logger } from "../relay/relay.ts";
import { applyRelayPatch, inspectAnchors } from "../tools/patch-spa.ts";
import { utf8ByteLength } from "../protocol/messages.ts";

const NOOP_LOGGER: Logger = { info: () => {}, warn: () => {} };

export const LOG_PREFIX = "/remote/v4";
export const LATEST_PREFIX = `${LOG_PREFIX}/latest/`;
/** 磁盘布局里资源所在的子目录段。 */
const ASSETS_DIR_SEGMENT = "assets/";
const ASSETS_PREFIX = `${LATEST_PREFIX}${ASSETS_DIR_SEGMENT}`;

/** 外壳的入口路径。 */
export const SHELL_PATHS = new Set([
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

export function contentTypeFor(path: string): string {
  return CONTENT_TYPES[posix.extname(path).toLowerCase()] ?? "application/octet-stream";
}

/**
 * 需要每次回源校验的两类响应：外壳（内嵌 relay 地址）与入口 bundle。
 *
 * no-cache 与 no-store 的区别是这条策略的关键：no-store 禁止浏览器留副本，
 * 于是每次页面加载都要重下整个入口（实测 4.6 MiB）；no-cache 允许留副本，
 * 只要求复用前回源问一次。配合 ETag，未变时回 304，重复访问的流量
 * 从整个入口降到一次条件请求。
 *
 * 入口**不能**用 immutable——补丁后内容已与文件名中的哈希不符，允许无条件
 * 复用会把旧 relay 地址钉死一年。no-cache 恰好保留了这种可更新性：
 * 补丁后的字节一变，ETag 就变，浏览器立刻拿到新版本。
 */
export const CACHE_REVALIDATE = "no-cache";

/** 文件名内含内容哈希、故内容与文件名必然一致：可长期无条件缓存。 */
export const CACHE_IMMUTABLE = "public, max-age=31536000, immutable";

export interface AssetProviderOptions {
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
  const pattern = new RegExp(
    `${ASSETS_PREFIX.replace(/\//g, "\\/")}(index-[A-Za-z0-9_-]+\\.js)`,
    "g",
  );
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

export class AssetProvider {
  readonly #root: string;
  readonly #log: Logger;
  readonly #relayUrl: string | undefined;
  readonly #patchEntry: boolean;
  /** 外壳（已注入 relay 地址），构建一次并缓存。 */
  #shell: Uint8Array | null = null;
  #entryName: string | null = null;
  /** 内存中的 patched 入口 bundle，磁盘上的原文件不动。 */
  #patched: Uint8Array | null = null;

  constructor(options: AssetProviderOptions) {
    this.#root = posix.resolve(options.rootDir);
    this.#relayUrl = options.relayUrl;
    this.#patchEntry = options.patchEntryBundle !== false;
    this.#log = options.logger ?? NOOP_LOGGER;
  }

  get rootDir(): string {
    return this.#root;
  }

  /** prepare() 探到的入口 bundle 名（未跑过 prepare 时为 null）。 */
  get entryBundleName(): string | null {
    return this.#entryName;
  }

  /** 内存中的 patched 入口；未套用时为 null。 */
  get patchedEntry(): Uint8Array | null {
    return this.#patched;
  }

  /**
   * 预检：解析外壳、定位入口 bundle、校验并预生成 patched 版本。
   * 必须在开始接受请求之前调用——anchor 不匹配时应当拒绝启动，
   * 而不是静默送出未 patch 的 bundle（那会让 SPA 悄悄连回厂商 relay）。
   */
  async prepare(): Promise<PrepareReport> {
    const shell = await this.shell();
    const html = new TextDecoder().decode(shell);

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

    let source: string;
    try {
      source = await Deno.readTextFile(posix.join(this.#root, "assets", entry));
    } catch (err) {
      if (!(err instanceof Deno.errors.NotFound)) throw err;
      return {
        shellBytes: shell.length,
        entryBundle: entry,
        patch: "failed",
        detail: `外壳引用的入口 bundle 缺失：assets/${entry} 不存在。` +
          `确认目录布局为 <资源目录>/index.html + <资源目录>/assets/*（资源文件不要直接放在根下）。` +
          `缺文件时重跑抓取补齐（幂等，已抓文件会跳过）：just fetch-assets ${this.#root}`,
      };
    }
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
        detail: `patch 锚点不匹配（overrideUrl:void 0 出现 ${String(anchors.overrideCount)} 次，` +
          `上下文锚点出现 ${String(anchors.functionCount)} 次，均应为 1）。` +
          `厂商构建可能已变化，见 docs/patching.md §5。`,
      };
    }

    const patched = new TextEncoder().encode(applyRelayPatch(source));
    this.#patched = patched;
    return {
      shellBytes: shell.length,
      entryBundle: entry,
      patch: "applied",
      detail: `内存 overlay：${String(utf8ByteLength(source))} → ` +
        `${String(patched.length)} 字节（磁盘文件未改动）`,
    };
  }

  /** 外壳与资源目录都没找到时，扫描目录兜底。 */
  async #scanForEntry(): Promise<string | null> {
    try {
      const candidates: string[] = [];
      for await (const entry of Deno.readDir(posix.join(this.#root, "assets"))) {
        if (entry.isFile && ENTRY_BUNDLE.test(entry.name)) candidates.push(entry.name);
      }
      return candidates.sort()[0] ?? null;
    } catch {
      return null;
    }
  }

  async #buildShell(): Promise<Uint8Array> {
    const raw = await Deno.readFile(posix.join(this.#root, "index.html"));
    if (this.#relayUrl === undefined) return raw;
    return new TextEncoder().encode(injectRelayMeta(new TextDecoder().decode(raw), this.#relayUrl));
  }

  /**
   * 外壳内容（已注入 relay 地址）。构建一次并缓存。
   * 编码协商与 ETag 由 Hono 中间件承担（见 `src/assets/routes.ts`）。
   */
  async shell(): Promise<Uint8Array> {
    const cached = this.#shell;
    if (cached !== null) return cached;
    const built = await this.#buildShell();
    this.#shell = built;
    return built;
  }

  /**
   * 请求的路径是否为入口 bundle（`assets/index-<hash>.js`）。
   *
   * 按文件名形状判断，而不比对 prepare() 探到的那个具体名字：这条不变量
   * （入口一律回源校验）不应当依赖 prepare() 是否跑过。厂商构建只会产出
   * 一个入口，即便这里有误判，代价也只是一次条件请求而非缓存命中。
   */
  isEntryPath(relativePath: string): boolean {
    if (!relativePath.startsWith(ASSETS_DIR_SEGMENT)) return false;
    return ENTRY_BUNDLE.test(relativePath.slice(ASSETS_DIR_SEGMENT.length));
  }

  /**
   * 把 URL 路径映射到磁盘路径。
   * 返回 null 表示应走外壳（SPA fallback）；抛错表示越界访问。
   */
  resolvePath(relativeUrlPath: string): string | null {
    const normalized = posix.normalize(relativeUrlPath).replace(/^(\.\.(\/|\\|$))+/, "");
    if (normalized === "" || normalized === "." || normalized === "index.html") return null;
    const absolute = posix.resolve(posix.join(this.#root, normalized));
    const inside = posix.relative(this.#root, absolute);
    if (inside.startsWith("..")) throw new Error("path escapes asset root");
    return absolute;
  }

  /** 状态页正文。 */
  statusText(): string {
    const patchState = this.#patched !== null
      ? `已套用（内存 overlay，磁盘未改动）→ ${String(this.#patched.length)} 字节`
      : this.#entryName === null
      ? "未找到入口 bundle"
      : "未套用（入口原样送出）";
    return [
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
  }
}
