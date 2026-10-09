/**
 * 资源托管的测试夹具与 Fastify 应用构造。
 *
 * 迁移前这里有一份手写的原始 HTTP 客户端（test/helpers/raw-http.ts），
 * 因为 `fetch` 会按 content-encoding 自动解压正文，断言不了"服务端真的发了 br"。
 * 现在直接用 Fastify 的 `app.inject()`：它不碰网络、**不解压**，
 * 原始字节在 `res.rawPayload` 里，于是那份客户端可以整个删掉。
 *
 * 需要真实 socket 的用例（连接中断、WebSocket）单独 `listen()`。
 */

import fastify, { type FastifyInstance } from "fastify";
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

/** 把 provider 挂到一个只有资源路由的 Fastify 实例上。 */
export function buildAssetApp(provider: AssetProvider): FastifyInstance {
  const app = fastify({ logger: false, forceCloseConnections: true });
  registerAssetRoutes(app, { provider });
  return app;
}

export interface AssetFixture {
  readonly root: string;
  readonly provider: AssetProvider;
  readonly app: FastifyInstance;
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

  return {
    root,
    provider,
    app,
    listen: async () => {
      await app.listen({ host: "127.0.0.1", port: 0 });
      const bound = app.server.address();
      if (bound === null || typeof bound === "string") throw new Error("app has no TCP address");
      return `http://127.0.0.1:${String(bound.port)}`;
    },
    close: async () => {
      await app.close();
      await Deno.remove(root, { recursive: true });
      await settleEventLoop();
    },
  };
}

/** 读取单值响应头。light-my-request 的响应头表允许 number（如 content-length）。 */
export function header(
  res: { headers: Record<string, string | number | string[] | undefined> },
  name: string,
): string {
  const value = res.headers[name];
  return Array.isArray(value) ? value.join(", ") : value === undefined ? "" : String(value);
}
