/**
 * 资源托管的 Hono 路由（design.md §3 的 `http-front` 模块）。
 *
 * 路由（与厂商站的路径保持一致，因为 SPA 内部用的是绝对路径引用）：
 *   /                         状态页（便于确认服务在跑）
 *   /healthz                  同上
 *   /remote/v4                配对链接的落点 → 外壳
 *   /remote/v4/               同上
 *   /remote/v4/latest/        外壳
 *   /remote/v4/latest/<path>  具体资源（入口 bundle 走内存 overlay）
 *   /remote/v4/<其他>         外壳（SPA 应用路由）
 *
 * 内容协商与条件请求由 Hono 内置中间件承担（`hono/compress` 的 gzip 与
 * `hono/etag` 的 SHA-1 ETag + 304），只挂在 `/remote/v4` 子树上；
 * 状态页与 WS 路由不受影响。本仓库保留的领域判断只有：按资源类的
 * 缓存策略（外壳与入口 `no-cache`、哈希资源 `immutable`）、入口 bundle
 * 不得发 `immutable`、内存 overlay 与路径越界判定。
 *
 * 路径从请求 URL 的 pathname 取：`new URL(c.req.url).pathname` 保留 `%2f`
 * 的编码形态（实测），于是 `..%2f..%2findex.html` 仍留在 assets/ 前缀内、
 * 因文件不存在而 404；而字面 `../..` 按 URL 语义折叠后落进 SPA fallback。
 */

import type { Context, Hono } from "hono";
import { compress } from "hono/compress";
import { etag } from "hono/etag";

import type { Logger } from "../relay/relay.ts";
import {
  AssetProvider,
  CACHE_IMMUTABLE,
  CACHE_REVALIDATE,
  contentTypeFor,
  LATEST_PREFIX,
  LOG_PREFIX,
  SHELL_PATHS,
} from "./provider.ts";

export interface AssetRoutesOptions {
  readonly provider: AssetProvider;
  readonly logger?: Logger;
}

const NOOP_LOGGER: Logger = { info: () => {}, warn: () => {} };

/** 取请求的 pathname（保留百分号编码，剥掉 query）。 */
function pathnameOf(c: Context): string | null {
  try {
    return new URL(c.req.url).pathname;
  } catch {
    return null;
  }
}

function baseHeaders(contentType: string): Record<string, string> {
  return {
    "content-type": contentType,
    "x-content-type-options": "nosniff",
  };
}

/**
 * 送出内存字节。ETag 与 304 由 `etag()` 中间件在最终字节上生成；
 * 这里只定内容类型、缓存策略与长度。HEAD 只回头不带正文。
 */
function memoryResponse(
  c: Context,
  relativePath: string,
  body: Uint8Array,
  cacheControl: string,
): Response {
  const headers: Record<string, string> = {
    ...baseHeaders(contentTypeFor(relativePath)),
    "content-length": String(body.byteLength),
    "cache-control": cacheControl,
  };
  if (c.req.method === "HEAD") return new Response(null, { status: 200, headers });
  // 运行接受任何 Uint8Array；断言只为绕开 TS 6 的 ArrayBufferLike 泛型。
  return new Response(body as unknown as BodyInit, { status: 200, headers });
}

/** 送出外壳。四个入口路径与 SPA fallback 都走这里。 */
async function shellResponse(c: Context, provider: AssetProvider): Promise<Response> {
  return memoryResponse(c, "index.html", await provider.shell(), CACHE_REVALIDATE);
}

/** 送出 /remote/v4/latest/ 下的一个资源。 */
async function assetResponse(
  c: Context,
  provider: AssetProvider,
  log: Logger,
  relativePath: string,
): Promise<Response> {
  // 入口 bundle：送出内存中的 patched 版本
  const patched = provider.patchedEntry;
  if (patched !== null && provider.isEntryPath(relativePath)) {
    return memoryResponse(c, relativePath, patched, CACHE_REVALIDATE);
  }

  let absolute: string | null;
  try {
    absolute = provider.resolvePath(relativePath);
  } catch {
    return new Response("forbidden", {
      status: 403,
      headers: { "content-type": "text/plain; charset=utf-8" },
    });
  }
  if (absolute === null) {
    // /latest/ 下不会有空路径或 index.html；真出现时按外壳处理。
    return await shellResponse(c, provider);
  }

  let info: Deno.FileInfo;
  try {
    info = await Deno.stat(absolute);
  } catch {
    log.warn("asset not found", { path: relativePath });
    return new Response(`asset not found: ${relativePath}`, {
      status: 404,
      headers: { "content-type": "text/plain; charset=utf-8" },
    });
  }
  if (!info.isFile) {
    return new Response("not found", {
      status: 404,
      headers: { "content-type": "text/plain; charset=utf-8" },
    });
  }

  // 走到这里说明入口没有内存 overlay（patch 关闭，或磁盘上已被 patch）。
  // 后者内容同样与文件名哈希不符，故入口路径一律要求回源校验。
  const cacheControl = provider.isEntryPath(relativePath) ? CACHE_REVALIDATE : CACHE_IMMUTABLE;

  const headers: Record<string, string> = {
    ...baseHeaders(contentTypeFor(relativePath)),
    "content-length": String(info.size),
    "cache-control": cacheControl,
  };

  if (c.req.method === "HEAD") {
    // 只回头不读文件：Hono 会把 GET 处理器用于 HEAD，若直接开流再丢弃，
    // 会为空耗一次 8 MiB 的读取。
    return new Response(null, { status: 200, headers });
  }

  // 流式响应：Response 的 body 接 Deno 文件的 Web 流。客户端中途断开时
  // 流被取消，文件资源随之释放（回归测试 test/assets-abort.test.ts 用 lsof
  // 直接数进程的 REG fd，不看实现）。压缩与 ETag 由中间件在该流上完成。
  const file = await Deno.open(absolute, { read: true });
  return new Response(file.readable, { status: 200, headers });
}

/**
 * 规范化后的 pathname 该走哪条路。这是本模块唯一的路径表，也是可单独测试的
 * 纯函数；Hono 的路由只负责把 `/remote/v4` 子树交给它。
 *
 * 为什么先规范化再判定：`new URL(...).pathname` 按 URL 语义折叠字面 `..`，
 * 因此 `/remote/v4/latest/assets/../../index.html` 会先变成
 * `/remote/v4/index.html`，落进 SPA fallback 而不是被当成名为 `../../index.html`
 * 的资源。若改成按**原始**路径判定，折叠类请求的归属就会变，而那是被测试
 * 钉住的既有行为。
 */
export type AssetRoute =
  | { readonly kind: "shell" }
  | { readonly kind: "asset"; readonly relative: string }
  | { readonly kind: "notfound" };

export function classifyRoute(pathname: string): AssetRoute {
  if (SHELL_PATHS.has(pathname)) return { kind: "shell" };
  if (pathname.startsWith(LATEST_PREFIX)) {
    // 剥掉 /remote/v4/latest/ 之后相对路径**保留** assets/ 段，
    // 因为磁盘布局就是 <root>/assets/<name>。
    const relative = pathname.slice(LATEST_PREFIX.length);
    return relative === "" ? { kind: "shell" } : { kind: "asset", relative };
  }
  // /remote/v4 下的其余路径 → SPA fallback（应用路由）
  if (pathname.startsWith(LOG_PREFIX)) return { kind: "shell" };
  return { kind: "notfound" };
}

async function dispatch(
  c: Context,
  provider: AssetProvider,
  log: Logger,
  route: AssetRoute,
): Promise<Response> {
  switch (route.kind) {
    case "shell":
      return await shellResponse(c, provider);
    case "asset":
      return await assetResponse(c, provider, log, route.relative);
    case "notfound":
      return new Response("not found", {
        status: 404,
        headers: { "content-type": "text/plain; charset=utf-8" },
      });
  }
}

export function registerAssetRoutes(app: Hono, options: AssetRoutesOptions): void {
  const { provider } = options;
  const log = options.logger ?? NOOP_LOGGER;

  const status = (): Response =>
    new Response(provider.statusText(), {
      status: 200,
      headers: { "content-type": "text/plain; charset=utf-8" },
    });

  app.get("/", status);
  app.get("/healthz", status);

  // /remote/v4 整棵子树走同一张路径表：状态页之外只有外壳、资源、404 三种结局。
  // Hono 的 GET 处理器同样服务 HEAD（body 由各分支按 method 裁掉），故只需注册 GET。
  // etag/compress 只挂子树：先注册 etag（外层）再注册 compress（内层），
  // 使 ETag 按最终送出的字节生成；状态页与 WS 路由不受影响。
  const subtree = (c: Context): Promise<Response> | Response => {
    const pathname = pathnameOf(c);
    if (pathname === null) return new Response(null, { status: 400 });
    return dispatch(c, provider, log, classifyRoute(pathname));
  };
  app.get(LOG_PREFIX, etag(), compress(), subtree);
  app.get(`${LOG_PREFIX}/*`, etag(), compress(), subtree);

  // 未匹配到任何路由。方法不对时回 405 而不是 404：
  // Hono 默认把所有未匹配都算 404，而既有行为对任何非 GET/HEAD 都回 405。
  app.notFound((c) => {
    if (c.req.method !== "GET" && c.req.method !== "HEAD") {
      return new Response(null, { status: 405, headers: { allow: "GET, HEAD" } });
    }
    return new Response("not found", {
      status: 404,
      headers: { "content-type": "text/plain; charset=utf-8" },
    });
  });
}
