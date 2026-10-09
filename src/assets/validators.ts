/**
 * HTTP 缓存校验符：强 ETag 的生成与 If-None-Match 匹配。
 *
 * 与 asset-server 的缓存**策略**（哪些响应必须回源校验）分开：那是本项目的
 * 领域判断，而校验符的计算是通用的，可以脱离 HTTP 单独测试。
 */

import { createHash } from "node:crypto";

/**
 * 强 ETag，对**实际送出的字节**取 sha256。
 *
 * 不能用文件名里的哈希：入口 bundle 被 patch 后两者必然不符，那正是它必须
 * 回源校验的原因。也不能用原文的哈希复用到压缩表示上——br 与 identity 是
 * 同一资源的两种表示，强校验符必须随之变化，否则 304 会把 br 的指纹
 * 配到 identity 的字节上。
 *
 * 内容确定 ⇒ 该值跨进程重启稳定，浏览器重启后仍能命中 304。
 */
export function strongEtag(body: Buffer): string {
  return `"${createHash("sha256").update(body).digest("base64url")}"`;
}

/**
 * If-None-Match 匹配。按 RFC 9110 §13.1.2 用弱比较：我们发强 ETag，
 * 但客户端可能回 `W/"..."`，两者都应命中。支持 `*` 与逗号分隔的列表。
 */
export function etagMatches(header: string | string[] | undefined, etag: string): boolean {
  if (header === undefined) return false;
  const raw = Array.isArray(header) ? header.join(",") : header;
  if (raw.trim() === "*") return true;
  return raw.split(",").some((candidate) => {
    const value = candidate.trim();
    return value === etag || value === `W/${etag}`;
  });
}
