/**
 * 线上消息类型与解析。字段语义见 docs/protocol.md §4。
 *
 * 设计要点：`data` 消息只读取信封的 `type`，保留**原始文本**用于转发。
 * 重组 JSON 会改变键序与数字格式，虽多半无害但无收益，故一律原样转发。
 * 这也满足协议要求"relay 不解析 payload"（§10.14 与 design.md §3 不变式 1）。
 *
 * 派发只依赖 `type` 这一个字段，所以先用**有界头部扫描**取它：大帧的 payload
 * 可达 1 MiB，为读一个字段而 JSON.parse 整条报文是把 payload 解析了一遍，
 * 既违背上面的不变式，实测也占每帧成本的 65%–77%。扫描不命中时回退完整解析，
 * 因此对字段顺序异常的报文语义不变。
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
 * 信封头部的 `type` 字段。§6.7 的记法把它写在最前，但那是 schema 记法，
 * 两侧实际的序列化键序尚未实测（见 protocol.md §13 未知项 11）。故这里
 * **不依赖键序**：扫不到就回退完整解析，键序异常只是慢，不会错。
 */
const TYPE_HEAD_PATTERN = /^\s*\{\s*"type"\s*:\s*"([^"]*)"/;

/** 头部扫描的窗口大小。足以覆盖信封开头，且对上 MiB 级报文是常数开销。 */
const HEAD_SCAN_CHARS = 256;

const UTF8 = new TextEncoder();

/** 报文按 UTF-8 编码后的字节数。 */
export function utf8ByteLength(text: string): number {
  // Deno 没有 Buffer.byteLength；TextEncoder 是唯一不依赖 node 兼容层的口径。
  // 调用方已知字节数时（WS 层拿到的是原始帧）应传 frameBytes，省掉这次编码。
  return UTF8.encode(text).byteLength;
}

/**
 * 解析一条入站消息。返回 null 表示格式非法，调用方应丢弃（不断连）。
 *
 * 仅严格校验 control 消息的信封字段；`data` 只认 `type`，其余原样保留。
 *
 * `frameBytes` 是这条报文的 UTF-8 字节数。WS 层已经知道它，传进来就不必
 * 为了量长度而把一个 MiB 级的字符串再编码一遍；省略时自行测量。
 */
export function parseInbound(raw: string, frameBytes?: number): Inbound | null {
  if ((frameBytes ?? utf8ByteLength(raw)) > MAX_PHYSICAL_FRAME_BYTES) return null;

  // 快路径：头部扫描认出 data 就直接放行，绝不触碰 payload。
  // 注意这里是有意不做整体合法性校验的——payload 是 base64 分片，其合法性由
  // 接收端逐条严格校验（§4.4），relay 只做字节管道。命中该路径的报文按原始
  // 文本逐字节转发。
  const head = TYPE_HEAD_PATTERN.exec(
    raw.length > HEAD_SCAN_CHARS ? raw.slice(0, HEAD_SCAN_CHARS) : raw,
  );
  if (head !== null && head[1] === "data") return { type: "data", raw };

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
