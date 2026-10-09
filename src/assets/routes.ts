/**
 * 资源托管的 Fastify 路由（design.md §3 的 `http-front` 模块）。
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
 * 搬迁到 Fastify 的边界很明确：方法分派、HEAD 的自动路由、404/405、
 * 流式响应与连接中断时的清理都交给框架；而**缓存语义与内容协商不交**——
 * 按表示计算的强校验符、入口 bundle 不得发 immutable、Vary 的声明范围
 * 都是本项目照证据定下的领域判断（design.md §3 的托管不变式），
 * 交给 @fastify/static / @fastify/compress / @fastify/etag 都会改变它们。
 *
 * 路径从 `request.raw.url` 取，不用 Fastify 解码后的 `params["*"]`：后者会把
 * `%2f` 解成 `/`（实测），于是 `..%2f..%2findex.html` 会变成一次真的越界尝试，
 * 响应从 404 变成 403。迁移前它落在 assets/ 前缀内、因文件不存在而 404，
 * 这条测试钉住的正是那个行为。
 */

import { Readable } from "node:stream";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";

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

/** 取请求的 pathname（保留百分号编码）。 */
function pathnameOf(request: FastifyRequest): string | null {
  const rawUrl = request.raw.url ?? request.url ?? "/";
  try {
    return new URL(rawUrl, "http://assets.invalid").pathname;
  } catch {
    return null;
  }
}

/** Fastify 的头表可能含 number（如 content-length），node:http 只接受字符串。 */
function headerRecord(
  headers: Record<string, string | number | string[] | undefined>,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(headers)) {
    if (value === undefined) continue;
    out[key] = Array.isArray(value) ? value.join(", ") : String(value);
  }
  return out;
}

/** 送出内存里的某个表示，并处理条件请求。
 *
 * 命中 If-None-Match 时回 304 且不带正文——这正是 no-cache 的价值所在：
 * 浏览器留着副本，只用一次条件请求确认，无需重下整个入口 bundle。
 *
 * 校验符属于**该表示**（br 与 identity 的 ETag 不同），故必须先用协商结果
 * 选出变体、再比对指纹，顺序不能反。
 */
function sendVariant(
  request: FastifyRequest,
  reply: FastifyReply,
  relativePath: string,
  variant: Variant,
  cacheControl: string,
  vary: boolean,
): FastifyReply {
  const { body, encoding, etag } = variant;
  // 声明 Vary 后，共享缓存才不会把这份表示回给不接受该编码的客户端。
  if (vary) reply.header("vary", "Accept-Encoding");

  if (etagMatches(request.headers["if-none-match"], etag)) {
    // 304 不带正文，但必须回 ETag 与 Cache-Control，
    // 否则浏览器无法把这次命中与已存的副本关联起来。
    return reply.code(304).header("etag", etag).header("cache-control", cacheControl).send();
  }

  reply
    .header("content-type", contentTypeFor(relativePath))
    .header("cache-control", cacheControl)
    .header("etag", etag)
    .header("x-content-type-options", "nosniff");
  if (encoding !== null) reply.header("content-encoding", encoding);
  // content-length 由 Fastify 按 payload 字节数写。压缩表示送的就是压缩后的
  // 字节，故长度自然是压缩后的长度。
  return reply.send(body);
}

/** 送出外壳。四个入口路径与 SPA fallback 都走这里。 */
async function sendShell(
  request: FastifyRequest,
  reply: FastifyReply,
  provider: AssetProvider,
): Promise<FastifyReply> {
  const store = await provider.shellStore();
  const variant = await store.select(negotiateEncoding(request.headers["accept-encoding"]));
  return sendVariant(request, reply, "index.html", variant, CACHE_REVALIDATE, true);
}

/** 送出 /remote/v4/latest/ 下的一个资源。 */
async function sendAsset(
  request: FastifyRequest,
  reply: FastifyReply,
  provider: AssetProvider,
  log: Logger,
  relativePath: string,
): Promise<FastifyReply> {
  // 入口 bundle：送出内存中的 patched 版本
  const patched = provider.patchedStore;
  if (patched !== null && provider.isEntryPath(relativePath)) {
    const variant = await patched.select(negotiateEncoding(request.headers["accept-encoding"]));
    return sendVariant(request, reply, relativePath, variant, CACHE_REVALIDATE, true);
  }

  let absolute: string | null;
  try {
    absolute = provider.resolvePath(relativePath);
  } catch {
    return reply.code(403).type("text/plain; charset=utf-8").send("forbidden");
  }
  if (absolute === null) {
    // /latest/ 下不会有空路径或 index.html；真出现时按外壳处理。
    return await sendShell(request, reply, provider);
  }

  let info: Deno.FileInfo;
  try {
    info = await Deno.stat(absolute);
  } catch {
    log.warn("asset not found", { path: relativePath });
    return reply.code(404).type("text/plain; charset=utf-8").send(
      `asset not found: ${relativePath}`,
    );
  }
  if (!info.isFile) return reply.code(404).send();

  // 走到这里说明入口没有内存 overlay（patch 关闭，或磁盘上已被 patch）。
  // 后者内容同样与文件名哈希不符，故入口路径一律要求回源校验。
  const cacheControl = provider.isEntryPath(relativePath) ? CACHE_REVALIDATE : CACHE_IMMUTABLE;
  const compressible = isCompressible(relativePath, info.size);
  const encoding = compressible
    ? negotiateEncoding(request.headers["accept-encoding"])
    : "identity";

  if (encoding !== "identity") {
    const variant = await provider.compressedFile(absolute, relativePath, encoding);
    return sendVariant(request, reply, relativePath, variant, cacheControl, true);
  }

  reply
    .header("content-type", contentTypeFor(relativePath))
    .header("content-length", String(info.size))
    .header("cache-control", cacheControl)
    .header("x-content-type-options", "nosniff");
  // 即使这次发的是未压缩内容也要声明：否则共享缓存可能把这份原文
  // 回给一个明确要求 br 的客户端。
  if (compressible) reply.header("vary", "Accept-Encoding");

  if (request.method === "HEAD") {
    // 只写头就收工。不能走 reply.send(stream)：Fastify 对 HEAD 也会把流读完
    // 再丢弃（实测 8 MiB 全被读出），而这里只需要头部。
    reply.hijack();
    reply.raw.writeHead(200, headerRecord(reply.getHeaders()));
    reply.raw.end();
    return reply;
  }

  // 流式响应交给 Fastify：它在响应结束或出错时销毁这条流，客户端中途断开
  // 也会走到销毁，于是文件描述符随之释放（迁移前是手写 stream.pipeline，
  // 理由见 design.md §3 托管不变式 2，回归测试 test/assets-abort.test.ts 守着）。
  //
  // 源流用 Deno.open 的 Web 流而不是 node:fs 的 createReadStream：Deno 的
  // 文件资源在流被取消时直接释放，而 node:fs 的 ReadStream 把 close 排到
  // 一个 setTimeout 上（实测会让 Deno 的 op 泄漏检查把关闭算到下一个用例头上）。
  const file = await Deno.open(absolute, { read: true });
  return reply.send(Readable.fromWeb(file.readable as NodeWebStream));
}

/**
 * Deno 的 `ReadableStream` 与 node:stream/web 的声明有一处不兼容（异步迭代器
 * 少一个 `[Symbol.asyncDispose]`），纯属两套类型声明打架，运行时是同一个
 * Web 流。故这里断言一次，而不是为了绕开类型问题退回 node:fs。
 */
type NodeWebStream = Parameters<typeof Readable.fromWeb>[0];

/**
 * 规范化后的 pathname 该走哪条路。这是本模块唯一的路径表，也是可单独测试的
 * 纯函数；Fastify 的路由只负责把 `/remote/v4` 子树交给它。
 *
 * 为什么先规范化再判定：迁移前就是这么做的（URL 解析 → pathname → 查表），
 * 因此 `/remote/v4/latest/assets/../../index.html` 会先折叠成
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

function dispatch(
  request: FastifyRequest,
  reply: FastifyReply,
  provider: AssetProvider,
  log: Logger,
  route: AssetRoute,
): FastifyReply | Promise<FastifyReply> {
  switch (route.kind) {
    case "shell":
      return sendShell(request, reply, provider);
    case "asset":
      return sendAsset(request, reply, provider, log, route.relative);
    case "notfound":
      return reply.code(404).type("text/plain; charset=utf-8").send("not found");
  }
}

export function registerAssetRoutes(app: FastifyInstance, options: AssetRoutesOptions): void {
  const { provider } = options;
  const log = options.logger ?? NOOP_LOGGER;

  const status = (_request: FastifyRequest, reply: FastifyReply): FastifyReply =>
    reply.type("text/plain; charset=utf-8").send(provider.statusText());

  app.get("/", status);
  app.get("/healthz", status);

  // /remote/v4 整棵子树走同一张路径表：状态页之外只有外壳、资源、404 三种结局。
  const subtree = (
    request: FastifyRequest,
    reply: FastifyReply,
  ): FastifyReply | Promise<FastifyReply> => {
    const pathname = pathnameOf(request);
    if (pathname === null) return reply.code(400).send();
    return dispatch(request, reply, provider, log, classifyRoute(pathname));
  };
  app.get(LOG_PREFIX, subtree);
  app.get(`${LOG_PREFIX}/*`, subtree);

  // 未匹配到任何路由。方法不对时回 405 而不是 404：
  // Fastify 默认把所有未匹配都算 404，而迁移前这里对任何非 GET/HEAD 都回 405。
  app.setNotFoundHandler((request, reply) => {
    if (request.method !== "GET" && request.method !== "HEAD") {
      return reply.code(405).header("allow", "GET, HEAD").send();
    }
    return reply.code(404).type("text/plain; charset=utf-8").send("not found");
  });
}
