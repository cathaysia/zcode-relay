/**
 * 用 `node:http` 直接发请求，拿到**未解压**的原始字节与响应头。
 *
 * 为什么不用 fetch：undici 会按 `content-encoding` 自动解压正文（实测正文
 * 解压、但保留该响应头），于是断言不了"服务端真的发了 br"以及压缩后的字节数。
 * 另外 `node:http` 默认不发 `accept-encoding`，编码协商完全由调用方控制。
 */

import { request } from "node:http";

export interface RawResponse {
  readonly status: number;
  readonly headers: NodeJS.Dict<string | string[]>;
  /** 未经任何解码的响应体。 */
  readonly body: Buffer;
}

export function rawGet(url: string, headers: Record<string, string> = {}): Promise<RawResponse> {
  return new Promise((resolve, reject) => {
    const req = request(url, { headers }, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (chunk: Buffer) => chunks.push(chunk));
      res.on("end", () => {
        resolve({
          status: res.statusCode ?? 0,
          headers: res.headers,
          body: Buffer.concat(chunks),
        });
      });
      res.on("error", reject);
    });
    req.on("error", reject);
    req.end();
  });
}
