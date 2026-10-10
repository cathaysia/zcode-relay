/**
 * 资源托管的测试夹具与 Hono 应用构造。
 *
 * 用 `app.request()`（不碰网络、**不解压**，原始字节经
 * `await res.arrayBuffer()` 取得）断言"服务端真的发了 br"；
 * 需要真实 socket 的用例（连接中断、WebSocket）单独 `Deno.serve()` 起端口。
 */

import { Hono } from "hono";
import * as posix from "@std/path/posix";

import { AssetProvider, type AssetProviderOptions } from "../../src/assets/provider.ts";
import { registerAssetRoutes } from "../../src/assets/routes.ts";
import { settleEventLoop } from "./settle.ts";

export const ENTRY_NAME = "index-AAA111.js";
export const CHUNK_NAME = "chunk-BBB222.js";
/** 体积过压缩阈值、内容可压的普通资源，用于验证内容协商。 */
export const BIG_CHUNK_NAME = "chunk-BIG333.js";
/** 扩展名表明已是压缩格式；内容故意用高度可压的全零，验证门槛按扩展名而非可压性。 */
export const PNG_NAME = "logo-CCC444.png";

/** 入口 bundle 夹具：含 patch 所需的两个锚点，周围是自有代码。 */
export const ENTRY_CONTENT = "var lead=function(){return 1};" +
  "function B4t(){return Mae({endpointOrigin:`https://zcode.z.ai`?.trim(),overrideUrl:void 0})}" +
  "var tail=function(){return 2};";

export const CHUNK_CONTENT = "export const shared=1;\n";

export const BIG_CHUNK_CONTENT = "export const shared = 1;\n".repeat(200);

export const SHELL =
  '<!doctype html>\n<html>\n  <head>\n    <meta charset="UTF-8" />\n  </head>\n' +
  "  <body>\n" +
  // 撑过压缩阈值，使外壳（内存路径）也能在 HTTP 层验证内容协商
  "    <!--" +
  " padding".repeat(300) +
  " -->\n" +
  `    <script type="module" src="/remote/v4/latest/assets/${ENTRY_NAME}"></script>\n` +
  "  </body>\n</html>";

export const RELAY_URL = "wss://relay.test/ws";

/** 建一棵标准夹具树，返回临时目录（调用方负责删除）。 */
export async function makeFixtureRoot(): Promise<string> {
  const root = await Deno.makeTempDir({ prefix: "zcassets-" });
  await Deno.mkdir(posix.join(root, "assets"), { recursive: true });
  await Deno.writeTextFile(posix.join(root, "index.html"), SHELL);
  await Deno.writeTextFile(posix.join(root, "assets", ENTRY_NAME), ENTRY_CONTENT);
  await Deno.writeTextFile(posix.join(root, "assets", CHUNK_NAME), CHUNK_CONTENT);
  await Deno.writeTextFile(posix.join(root, "assets", BIG_CHUNK_NAME), BIG_CHUNK_CONTENT);
  await Deno.writeFile(posix.join(root, "assets", PNG_NAME), new Uint8Array(4096));
  return root;
}

/** 把 provider 挂到一个只有资源路由的 Hono 实例上。 */
export function buildAssetApp(provider: AssetProvider): Hono {
  const app = new Hono();
  registerAssetRoutes(app, { provider });
  return app;
}

export interface AssetFixture {
  readonly root: string;
  readonly provider: AssetProvider;
  readonly app: Hono;
  /** 起真实端口，返回 origin（形如 http://127.0.0.1:34567）。 */
  listen(): Promise<string>;
  /** 关服务并删除临时目录。 */
  close(): Promise<void>;
}

export interface AssetFixtureOptions {
  readonly relayUrl?: string | undefined;
  readonly patchEntryBundle?: boolean | undefined;
}

export async function createAssetFixture(options: AssetFixtureOptions = {}): Promise<AssetFixture> {
  const root = await makeFixtureRoot();
  const providerOptions: AssetProviderOptions = {
    rootDir: root,
    relayUrl: options.relayUrl === undefined ? RELAY_URL : options.relayUrl,
    patchEntryBundle: options.patchEntryBundle,
  };
  const provider = new AssetProvider(providerOptions);
  const app = buildAssetApp(provider);
  let server: Deno.HttpServer | null = null;

  return {
    root,
    provider,
    app,
    listen: () => {
      server = Deno.serve({ hostname: "127.0.0.1", port: 0, onListen: () => {} }, app.fetch);
      const addr = server.addr as Deno.NetAddr;
      return Promise.resolve(`http://127.0.0.1:${String(addr.port)}`);
    },
    close: async () => {
      if (server !== null) {
        await server.shutdown();
        server = null;
      }
      await Deno.remove(root, { recursive: true });
      await settleEventLoop();
    },
  };
}

/** 发起应用内请求：不碰网络、不解压。调用方按需传完整 URL 或路径。 */
export async function assetRequest(
  app: Hono,
  path: string,
  init?: RequestInit,
): Promise<Response> {
  const url = path.startsWith("http") ? path : `http://assets.test${path}`;
  return init === undefined ? await app.request(url) : await app.request(url, init);
}

/**
 * 测试用的 inject 兼容层：把 Fetch Response 转成与此前 light-my-request
 * 同形的 `{statusCode, body, headers, rawPayload}`，使既有断言无需重写。
 * `body` 为 UTF-8 文本（文本断言用），`rawPayload` 为线上原始字节
 * （压缩断言用，不解压）。
 */
export interface InjectedResponse {
  readonly statusCode: number;
  readonly body: string;
  readonly headers: Record<string, string>;
  readonly rawPayload: Uint8Array;
}

export interface InjectOptions {
  readonly url: string;
  readonly method?: string;
  readonly headers?: Record<string, string>;
}

export async function inject(app: Hono, options: InjectOptions): Promise<InjectedResponse> {
  const url = options.url.startsWith("http") ? options.url : `http://assets.test${options.url}`;
  const init: RequestInit = { method: options.method ?? "GET" };
  if (options.headers !== undefined) init.headers = options.headers;
  const res = await app.request(url, init);
  const rawPayload = new Uint8Array(await res.arrayBuffer());
  const headers: Record<string, string> = {};
  res.headers.forEach((value, key) => {
    headers[key] = value;
  });
  return {
    statusCode: res.status,
    body: new TextDecoder().decode(rawPayload),
    headers,
    rawPayload,
  };
}

/** 读取单值响应头（兼容 Fetch Response 与 inject 兼容层）。 */
export function header(
  res: Response | { headers: Headers | Record<string, string | number | string[] | undefined> },
  name: string,
): string {
  const headers = res.headers;
  if (headers instanceof Headers) return headers.get(name) ?? "";
  const value = (headers as Record<string, string | number | string[] | undefined>)[name];
  return Array.isArray(value) ? value.join(", ") : value === undefined ? "" : String(value);
}

/** 读取响应正文为文本。 */
export function bodyText(res: Response): Promise<string> {
  return res.text();
}

/** 读取响应正文为原始字节（不解压看到的就是线上字节）。 */
export async function bodyBytes(res: Response): Promise<Uint8Array> {
  return new Uint8Array(await res.arrayBuffer());
}
