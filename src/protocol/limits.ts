/**
 * 协议常量。值来自对 device 侧与 terminal 侧 bundle 的双向逆向，
 * 见 docs/protocol.md §9。改动这些值前先核对协议文档。
 */

/** 单条 WS 消息（UTF-8 编码后）的硬上限。超出会被对端判为故障并降级桥接。 */
export const MAX_PHYSICAL_FRAME_BYTES = 1024 * 1024;

/** 单条逻辑消息（多分片重组后）的上限。relay 不组装，仅用于文档与测试。 */
export const MAX_MESSAGE_BYTES = 16 * 1024 * 1024;

/** 单条逻辑消息的最大分片数。relay 不组装，仅用于文档与测试。 */
export const MAX_FRAGMENTS = 64;

/** id 类字段（bridgeSessionId / recoveryId）的最大字符数。 */
export const TRANSPORT_ID_MAX_CHARS = 256;

/** 心跳应答看门狗。缺失 pair_status 时对端会等到此时长后重连。 */
export const HEARTBEAT_ACK_TIMEOUT_MS = 30_000;

/** 终端在从未配对状态下的等待超时。 */
export const TERMINAL_WAITING_TIMEOUT_MS = 30_000;

/** 设备离线后终端的宽限期。 */
export const DESKTOP_OFFLINE_GRACE_MS = 15_000;

/** relay 允许的 error.code 全集。绝不可扩展——两侧把未知 code 视为致命且不重连。 */
export const RELAY_ERROR_CODES = [
  "AUTH_FAILED",
  "KICKED",
  "DEVICE_OFFLINE",
  "INTERNAL",
  "WRONG_PARAM",
] as const;

export type RelayErrorCode = (typeof RELAY_ERROR_CODES)[number];

/** 配对状态。 */
export type PairStatus = "waiting" | "matched";

/** 认证角色。proof 与该字符串绑定，弄错必然校验失败。 */
export type AuthRole = "device" | "terminal";
