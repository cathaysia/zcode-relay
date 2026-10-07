/**
 * 配对密钥与认证证明。语义见 docs/protocol.md §3。
 *
 * 三个编码刻意不同，不要统一：
 *   pass_hash  -> 标准 base64，**带** '=' 填充
 *   proof      -> base64url，**无**填充
 *   dataBase64 -> 标准 base64（见 src/protocol/framing.ts）
 */

import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import type { AuthRole } from "./limits.ts";

/**
 * 生成配对密码。等价于 device 侧 createPassword：
 * 24 字节随机数的 base64url 表示（32 字符）。
 * 仅测试与工具需要；relay 本身不生成密码。
 */
export function createPassword(): string {
  return randomBytes(24).toString("base64url");
}

/**
 * 计算 pass_hash。等价于 device 侧 createPassHash。
 * 这是设备在首次注册时交给 relay 的值，也是 proof 的 HMAC 密钥。
 */
export function derivePassHash(password: string): string {
  return createHash("sha256").update(password).digest("base64");
}

/**
 * 计算认证证明。等价于两侧的 calculateProof：
 *   base64url_nopad(HMAC_SHA256(key = passHash 的 UTF-8 字节,
 *                               msg = `${nonce}|${role}|${deviceSid}`))
 *
 * role 参与消息构造，故角色弄错必然校验失败——这是协议自带的绑定。
 */
export function calculateProof(
  passHash: string,
  nonce: string,
  role: AuthRole,
  deviceSid: string,
): string {
  return createHmac("sha256", passHash)
    .update(`${nonce}|${role}|${deviceSid}`)
    .digest("base64url");
}

/**
 * 定长安全比较。长度不等时直接返回 false（长度本身不算秘密：
 * proof 长度由算法决定，恒定）。
 */
export function verifyProof(expected: string, actual: string): boolean {
  const a = Buffer.from(expected, "utf8");
  const b = Buffer.from(actual, "utf8");
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

/** 生成 device_sid。URL 安全，因为该值会出现在二维码查询参数里。 */
export function createDeviceSid(): string {
  return randomBytes(24).toString("base64url");
}

/**
 * 生成认证挑战 nonce。
 * 协议未约束格式（客户端只要求"存在的非空字符串"），
 * 这里取 32 字节随机数的 base64url，不可预测且足够长。
 */
export function createNonce(): string {
  return randomBytes(32).toString("base64url");
}

/** 生成 relay 侧的连接标识，仅用于日志。 */
export function createConnId(): string {
  return randomBytes(8).toString("hex");
}
