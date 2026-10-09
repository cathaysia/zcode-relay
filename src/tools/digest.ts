/**
 * 工具用的摘要助手。
 *
 * 抓取清单与漂移检测都按 sha256 十六进制比对，故放在工具目录而不是
 * protocol/：它不属于线上协议的任何一环，只是运维口径。
 */

import { encodeHex } from "@std/encoding/hex";

export async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return encodeHex(new Uint8Array(digest));
}
