/**
 * 配对密钥与认证证明。语义见 docs/protocol.md §3。
 *
 * 实现用 Web Crypto（`crypto.subtle` / `crypto.getRandomValues`），不用 node:crypto：
 * Deno 原生提供前者，且 terminal 侧客户端本身就用 `crypto.subtle` 计算 proof，
 * 两侧同源。`subtle.verify` 还顺带把"比较"这步做成定长比较，不必手写常量
 * 时间比较（手写的反而更容易被 JIT 优化出提前返回）。
 *
 * 代价：HMAC 只有异步接口，故 calculateProof / verifyProof 是 async。
 * 随机数与编码仍是同步的，因此 relay 的热路径（data 转发）不受影响；
 * 认证路径的异步由 RelayCore 按连接串行化，见 src/relay/relay.ts。
 *
 * 三个编码刻意不同，不要统一：
 *   pass_hash  -> 标准 base64，**带** '=' 填充
 *   proof      -> base64url，**无**填充
 *   dataBase64 -> 标准 base64（见 docs/protocol.md §6.1）
 */

import { encodeBase64 } from "@std/encoding/base64";
import { decodeBase64Url, encodeBase64Url } from "@std/encoding/base64url";
import type { AuthRole } from "./limits.ts";

const UTF8 = new TextEncoder();

/** HMAC 的密钥材料是 pass_hash 的 UTF-8 字节，不是它的 base64 解码。 */
async function hmacKey(passHash: string): Promise<CryptoKey> {
  return await crypto.subtle.importKey(
    "raw",
    UTF8.encode(passHash),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign", "verify"],
  );
}

/**
 * 生成配对密码。等价于 device 侧 createPassword：
 * 24 字节随机数的 base64url 表示（32 字符，无填充）。
 * 仅测试与工具需要；relay 本身不生成密码。
 */
export function createPassword(): string {
  return encodeBase64Url(crypto.getRandomValues(new Uint8Array(24)));
}

/**
 * 计算 pass_hash。等价于 device 侧 createPassHash。
 * 这是设备在首次注册时交给 relay 的值，也是 proof 的 HMAC 密钥。
 */
export async function derivePassHash(password: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", UTF8.encode(password));
  return encodeBase64(new Uint8Array(digest));
}

/**
 * 计算认证证明。等价于两侧的 calculateProof：
 *   base64url_nopad(HMAC_SHA256(key = passHash 的 UTF-8 字节,
 *                               msg = `${nonce}|${role}|${deviceSid}`))
 *
 * role 参与消息构造，故角色弄错必然校验失败——这是协议自带的绑定。
 */
export async function calculateProof(
  passHash: string,
  nonce: string,
  role: AuthRole,
  deviceSid: string,
): Promise<string> {
  const signature = await crypto.subtle.sign(
    "HMAC",
    await hmacKey(passHash),
    UTF8.encode(`${nonce}|${role}|${deviceSid}`),
  );
  return encodeBase64Url(new Uint8Array(signature));
}

/**
 * 校验认证证明。proof 是 base64url 无填充的 HMAC，故直接交给 `subtle.verify`
 * 做定长比较，而不是自己比较两个字符串。
 *
 * proof 不是合法 base64url 时返回 false 而不抛错——非法输入与错误 proof
 * 在协议上是同一回事（都是 AUTH_FAILED）。
 */
export async function verifyProof(
  passHash: string,
  nonce: string,
  role: AuthRole,
  deviceSid: string,
  proof: string,
): Promise<boolean> {
  let signature: Uint8Array;
  try {
    signature = decodeBase64Url(proof);
  } catch {
    return false;
  }
  return await crypto.subtle.verify(
    "HMAC",
    await hmacKey(passHash),
    signature,
    UTF8.encode(`${nonce}|${role}|${deviceSid}`),
  );
}

/** 生成 device_sid。URL 安全，因为该值会出现在二维码查询参数里。 */
export function createDeviceSid(): string {
  return encodeBase64Url(crypto.getRandomValues(new Uint8Array(24)));
}

/**
 * 生成认证挑战 nonce。
 * 协议未约束格式（客户端只要求"存在的非空字符串"），
 * 这里取 32 字节随机数的 base64url，不可预测且足够长。
 */
export function createNonce(): string {
  return encodeBase64Url(crypto.getRandomValues(new Uint8Array(32)));
}

/** 生成 relay 侧的连接标识，仅用于日志。 */
export function createConnId(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(8));
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}
