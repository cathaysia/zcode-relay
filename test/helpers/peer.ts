/**
 * 测试用对端驱动：把握手细节封装起来，让用例读起来接近 docs/design.md §5.1 的 BDD 场景。
 *
 * 全是 async：认证校验走 Web Crypto，没有同步入口（见 src/protocol/crypto.ts）。
 * 调用方必须 await——否则断言会跑在校验完成之前。
 */

import { FakeConn } from "./fake-conn.ts";
import type { RelayCore } from "../../src/relay/relay.ts";
import type { AuthRole } from "../../src/protocol/limits.ts";
import { calculateProof } from "../../src/protocol/crypto.ts";

export interface DevicePeer {
  readonly conn: FakeConn;
  readonly sid: string;
  readonly passHash: string;
}

export interface TerminalPeer {
  readonly conn: FakeConn;
  readonly sid: string;
}

function meta(name: string): Record<string, string> {
  return { platform: "test", version: "0.0.0", name };
}

/** 走完设备侧完整握手：注册 → auth_init → 挑战 → auth_response。 */
export async function connectDevice(
  core: RelayCore,
  passHash: string,
  mid = "device-mid-1",
): Promise<DevicePeer> {
  const conn = new FakeConn("device");
  core.handleConnect(conn);

  await core.handleMessage(
    conn,
    JSON.stringify({
      type: "device_register_init",
      device_mid: mid,
      pass_hash: passHash,
      meta: meta("desktop-test"),
      client_ts: 1,
    }),
  );
  const ack = conn.ofType("device_register_ack").at(-1);
  if (ack === undefined) throw new Error("设备未收到 device_register_ack");
  const sid = String(ack["device_sid"]);

  await authenticate(core, conn, passHash, sid, "device");
  return { conn, sid, passHash };
}

/** 走完终端侧完整握手：auth_init → 挑战 → auth_response。 */
export async function connectTerminal(
  core: RelayCore,
  passHash: string,
  sid: string,
): Promise<TerminalPeer> {
  const conn = new FakeConn("terminal");
  core.handleConnect(conn);
  await authenticate(core, conn, passHash, sid, "terminal");
  return { conn, sid };
}

/** 单角色认证：发 auth_init，用收到的 nonce 算 proof 再发 auth_response。 */
export async function authenticate(
  core: RelayCore,
  conn: FakeConn,
  passHash: string,
  sid: string,
  role: AuthRole,
): Promise<void> {
  await core.handleMessage(
    conn,
    JSON.stringify({
      type: "auth_init",
      role,
      device_sid: sid,
      meta: meta(role === "device" ? "desktop-test" : "mobile-browser"),
      client_ts: 1,
    }),
  );
  const challenge = conn.ofType("auth_challenge").at(-1);
  if (challenge === undefined) throw new Error(`${role} 未收到 auth_challenge`);
  const nonce = String(challenge["nonce"]);

  await core.handleMessage(
    conn,
    JSON.stringify({
      type: "auth_response",
      device_sid: sid,
      proof: await calculateProof(passHash, nonce, role, sid),
      client_ts: 1,
    }),
  );
}

/** 以错误的 proof 认证，用于负面用例。 */
export async function authenticateWithWrongProof(
  core: RelayCore,
  conn: FakeConn,
  sid: string,
  role: AuthRole,
  wrongProof = "not-a-valid-proof",
): Promise<void> {
  await core.handleMessage(
    conn,
    JSON.stringify({
      type: "auth_init",
      role,
      device_sid: sid,
      meta: meta("bad"),
      client_ts: 1,
    }),
  );
  await core.handleMessage(
    conn,
    JSON.stringify({
      type: "auth_response",
      device_sid: sid,
      proof: wrongProof,
      client_ts: 1,
    }),
  );
}

/** 用错误的角色计算 proof（角色绑定测试）。 */
export async function authenticateWithWrongRole(
  core: RelayCore,
  conn: FakeConn,
  passHash: string,
  sid: string,
  declared: AuthRole,
  proofRole: AuthRole,
): Promise<void> {
  await core.handleMessage(
    conn,
    JSON.stringify({
      type: "auth_init",
      role: declared,
      device_sid: sid,
      meta: meta("wrong-role"),
      client_ts: 1,
    }),
  );
  const challenge = conn.ofType("auth_challenge").at(-1);
  if (challenge === undefined) throw new Error("未收到 auth_challenge");
  const nonce = String(challenge["nonce"]);
  await core.handleMessage(
    conn,
    JSON.stringify({
      type: "auth_response",
      device_sid: sid,
      proof: await calculateProof(passHash, nonce, proofRole, sid),
      client_ts: 1,
    }),
  );
}

export function sendHeartbeat(core: RelayCore, conn: FakeConn, sid: string): Promise<void> {
  return core.handleMessage(
    conn,
    JSON.stringify({ type: "pair_status_query", device_sid: sid, client_ts: 1 }),
  );
}

/**
 * 构造一条 data 消息。payload 刻意包含嵌套对象、未知字段与
 * 需要保持原样的数字，用于验证逐字节转发。
 */
export function makeDataFrame(raw: string): string {
  return JSON.stringify({ type: "data", payload: JSON.parse(raw), client_ts: 1234 });
}

/** 一条内容刻意"难以规范化"的 rpc-frame。 */
export const SAMPLE_RPC_FRAME = JSON.stringify({
  zcode_type: "rpc-frame",
  bridgeSessionId: "bridge-1",
  bridgeGeneration: 0,
  recoveryId: "recovery-1",
  seq: 1,
  messageSeq: 1,
  fragmentIndex: 0,
  fragmentCount: 1,
  messageBytes: 17,
  checksum: { algorithm: "crc32", value: "00000000" },
  dataBase64: "AAAAAAAAAAAAAAAAAAAAAA==",
  unknownFutureField: { nested: [1, 2, { deep: true }] },
});
