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
 * 分工很明确：路由、方法分派、HEAD、404/405、流式响应与连接中断时的清理
 * 由 Hono + Deno.serve 的 Response 机制承担；而**缓存语义与内容协商不交**——
 * 按表示计算的强校验符、入口 bundle 不得发 immutable、Vary 的声明范围
 * 都是本项目照证据定下的领域判断（design.md §3 的托管不变式）。
 *
 * 路径从请求 URL 的 pathname 取：`new URL(c.req.url).pathname` 保留 `%2f`
 * 的编码形态（实测），于是 `..%2f..%2findex.html` 仍留在 assets/ 前缀内、
 * 因文件不存在而 404；而字面 `../..` 按 URL 语义折叠后落进 SPA fallback。
 */

import type { Context, Hono } from "hono";

import type { Logger } from "../relay/relay.ts";
import { isCompressible, negotiateEncoding, type Variant } from "./encoding.ts";
import {
  AssetProvider,
  CACHE_IMMUTABLE,
  CACHE_REVALIDATE,
  contentTypeFor,
  LATEST_PREFIX,
  LOG_PREFIX,
  SHELL_PATHS,
} from "./provider.ts";
import { etagMatches } from "./validators.ts";

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

/** 送出内存里的某个表示，并处理条件请求。
 *
 * 命中 If-None-Match 时回 304 且不带正文——这正是 no-cache 的价值所在：
 * 浏览器留着副本，只用一次条件请求确认，无需重下整个入口 bundle。
 *
 * 校验符属于**该表示**（br 与 identity 的 ETag 不同），故必须先用协商结果
 * 选出变体、再比对指纹，顺序不能反。304 同样声明 Vary，否则共享缓存会把
 * 这份 304 的含义配到错误的表示上。
 */
function variantResponse(
  c: Context,
  relativePath: string,
  variant: Variant,
  cacheControl: string,
  vary: boolean,
): Response {
  const { body, encoding, etag } = variant;
  const headers: Record<string, string> = {
    ...baseHeaders(contentTypeFor(relativePath)),
    "cache-control": cacheControl,
    "etag": etag,
    "content-length": String(body.byteLength),
  };
  if (vary) headers["vary"] = "Accept-Encoding";
  if (encoding !== null) headers["content-encoding"] = encoding;

  if (etagMatches(c.req.header("if-none-match"), etag)) {
    // 304 不带正文，但必须回 ETag 与 Cache-Control，
    // 否则浏览器无法把这次命中与已存的副本关联起来。
    const notModified: Record<string, string> = {
      "etag": etag,
      "cache-control": cacheControl,
    };
    if (vary) notModified["vary"] = "Accept-Encoding";
    return new Response(null, { status: 304, headers: notModified });
  }

  if (c.req.method === "HEAD") return new Response(null, { status: 200, headers });
  // 运行接受任何 Uint8Array；断言只为绕开 TS 6 的 ArrayBufferLike 泛型。
  return new Response(body as unknown as BodyInit, { status: 200, headers });
}

/** 送出外壳。四个入口路径与 SPA fallback 都走这里。 */
async function shellResponse(c: Context, provider: AssetProvider): Promise<Response> {
  const store = await provider.shellStore();
  const variant = await store.select(negotiateEncoding(c.req.header("accept-encoding")));
  return variantResponse(c, "index.html", variant, CACHE_REVALIDATE, true);
}

/** 送出 /remote/v4/latest/ 下的一个资源。 */
async function assetResponse(
  c: Context,
  provider: AssetProvider,
  log: Logger,
  relativePath: string,
): Promise<Response> {
  // 入口 bundle：送出内存中的 patched 版本
  const patched = provider.patchedStore;
  if (patched !== null && provider.isEntryPath(relativePath)) {
    const variant = await patched.select(negotiateEncoding(c.req.header("accept-encoding")));
    return variantResponse(c, relativePath, variant, CACHE_REVALIDATE, true);
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
  const compressible = isCompressible(relativePath, info.size);
  const encoding = compressible ? negotiateEncoding(c.req.header("accept-encoding")) : "identity";

  if (encoding !== "identity") {
    const variant = await provider.compressedFile(absolute, relativePath, encoding);
    return variantResponse(c, relativePath, variant, cacheControl, true);
  }

  const headers: Record<string, string> = {
    ...baseHeaders(contentTypeFor(relativePath)),
    "content-length": String(info.size),
    "cache-control": cacheControl,
  };
  // 即使这次发的是未压缩内容也要声明：否则共享缓存可能把这份原文
  // 回给一个明确要求 br 的客户端。
  if (compressible) headers["vary"] = "Accept-Encoding";

  if (c.req.method === "HEAD") {
    // 只回头不读文件：Hono 会把 GET 处理器用于 HEAD，若直接开流再丢弃，
    // 会为空耗一次 8 MiB 的读取。
    return new Response(null, { status: 200, headers });
  }

  // 流式响应：Response 的 body 接 Deno 文件的 Web 流。客户端中途断开时
  // 流被取消，文件资源随之释放（回归测试 test/assets-abort.test.ts 用 lsof
  // 直接数进程的 REG fd，不看实现）。
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
  const subtree = (c: Context): Promise<Response> | Response => {
    const pathname = pathnameOf(c);
    if (pathname === null) return new Response(null, { status: 400 });
    return dispatch(c, provider, log, classifyRoute(pathname));
  };
  app.get(LOG_PREFIX, subtree);
  app.get(`${LOG_PREFIX}/*`, subtree);

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
