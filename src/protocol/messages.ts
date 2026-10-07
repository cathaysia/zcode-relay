/**
 * 线上消息类型与解析。字段语义见 docs/protocol.md §4。
 *
 * 设计要点：`data` 消息只读取信封的 `type`，保留**原始文本**用于转发。
 * 重组 JSON 会改变键序与数字格式，虽多半无害但无收益，故一律原样转发。
 * 这也满足协议要求"relay 不解析 payload"。
 */

import type { AuthRole, PairStatus, RelayErrorCode } from "./limits.ts";
import { MAX_PHYSICAL_FRAME_BYTES } from "./limits.ts";

export interface PeerMeta {
  platform: string;
  version: string;
  name: string;
}

/** relay 接收的消息。 */
export type Inbound =
  | { type: "device_register_init"; deviceMid: string; passHash: string; meta: PeerMeta }
  | { type: "auth_init"; role: AuthRole; deviceSid: string; meta: PeerMeta }
  | { type: "auth_response"; deviceSid: string; proof: string }
  | { type: "pair_status_query"; deviceSid: string }
  /** 载荷不透明：仅保留原始文本供逐字节转发。 */
  | { type: "data"; raw: string };

/** relay 发出的消息（不含 data；data 走原样转发路径）。 */
export type Outbound =
  | { type: "device_register_ack"; device_sid: string }
  | { type: "auth_challenge"; nonce: string }
  | { type: "auth_ack"; pair_status: PairStatus }
  | { type: "pair_status_ack"; pair_status: PairStatus }
  | { type: "error"; code: RelayErrorCode; message?: string };

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function str(o: Record<string, unknown>, k: string): string | undefined {
  const v = o[k];
  return typeof v === "string" && v.length > 0 ? v : undefined;
}

function parseMeta(v: unknown): PeerMeta {
  if (!isRecord(v)) return { platform: "unknown", version: "unknown", name: "unknown" };
  return {
    platform: typeof v["platform"] === "string" ? v["platform"] : "unknown",
    version: typeof v["version"] === "string" ? v["version"] : "unknown",
    name: typeof v["name"] === "string" ? v["name"] : "unknown",
  };
}

/**
 * 解析一条入站消息。返回 null 表示格式非法，调用方应丢弃（不断连）。
 *
 * 仅严格校验 control 消息的信封字段；`data` 只认 `type`，其余原样保留。
 */
export function parseInbound(raw: string): Inbound | null {
  if (Buffer.byteLength(raw, "utf8") > MAX_PHYSICAL_FRAME_BYTES) return null;

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!isRecord(parsed)) return null;

  const type = parsed["type"];
  if (typeof type !== "string") return null;

  switch (type) {
    case "device_register_init": {
      const deviceMid = str(parsed, "device_mid");
      const passHash = str(parsed, "pass_hash");
      if (!deviceMid || !passHash) return null;
      return { type, deviceMid, passHash, meta: parseMeta(parsed["meta"]) };
    }
    case "auth_init": {
      const role = parsed["role"];
      if (role !== "device" && role !== "terminal") return null;
      const deviceSid = str(parsed, "device_sid");
      if (!deviceSid) return null;
      return { type, role, deviceSid, meta: parseMeta(parsed["meta"]) };
    }
    case "auth_response": {
      const deviceSid = str(parsed, "device_sid");
      const proof = str(parsed, "proof");
      if (!deviceSid || !proof) return null;
      return { type, deviceSid, proof };
    }
    case "pair_status_query": {
      const deviceSid = str(parsed, "device_sid");
      if (!deviceSid) return null;
      return { type, deviceSid };
    }
    case "data":
      // payload 不透明，保留原始文本
      return { type, raw };
    default:
      return null;
  }
}

/** 序列化一条出站 control 消息。 */
export function serializeOutbound(msg: Outbound): string {
  return JSON.stringify(msg);
}

/** 构造 error 消息。message 可省略（客户端只展示 message ?? code）。 */
export function errorMessage(code: RelayErrorCode, message?: string): Outbound {
  return message === undefined ? { type: "error", code } : { type: "error", code, message };
}
