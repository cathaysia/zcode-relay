import { test } from "node:test";
import assert from "node:assert/strict";

import { RelayCore } from "../src/relay/relay.ts";
import { derivePassHash } from "../src/protocol/crypto.ts";
import { MAX_PHYSICAL_FRAME_BYTES } from "../src/protocol/limits.ts";
import { FakeConn } from "./helpers/fake-conn.ts";
import {
  authenticate,
  authenticateWithWrongProof,
  authenticateWithWrongRole,
  connectDevice,
  connectTerminal,
  SAMPLE_RPC_FRAME,
  sendHeartbeat,
} from "./helpers/peer.ts";

const PASS_HASH = derivePassHash("test-password");

function newCore(): RelayCore {
  return new RelayCore();
}

// ---------- 注册与认证 ----------

test("设备注册后得到唯一 device_sid 并进入 waiting", () => {
  const core = newCore();
  const conn = new FakeConn("device");
  core.handleConnect(conn);

  core.handleMessage(
    conn,
    JSON.stringify({
      type: "device_register_init",
      device_mid: "m1",
      pass_hash: PASS_HASH,
      meta: { platform: "linux", version: "3.14.4", name: "desktop" },
      client_ts: 1,
    }),
  );

  const ack = conn.ofType("device_register_ack").at(-1);
  assert.ok(ack, "必须返回 device_register_ack");
  const sid = String(ack["device_sid"]);
  assert.ok(sid.length > 0);

  // 认证后无终端接入 → waiting
  authenticate(core, conn, PASS_HASH, sid, "device");
  const authAck = conn.ofType("auth_ack").at(-1);
  assert.equal(authAck?.["pair_status"], "waiting", "无终端时应为 waiting");
});

test("两次注册得到不同的 device_sid", () => {
  const core = newCore();
  const sids = new Set<string>();
  for (let i = 0; i < 2; i += 1) {
    const conn = new FakeConn("device");
    core.handleConnect(conn);
    core.handleMessage(
      conn,
      JSON.stringify({
        type: "device_register_init",
        device_mid: `m${i}`,
        pass_hash: PASS_HASH,
        meta: { platform: "linux", version: "1", name: "d" },
        client_ts: 1,
      }),
    );
    sids.add(String(conn.ofType("device_register_ack").at(-1)?.["device_sid"]));
  }
  assert.equal(sids.size, 2, "device_sid 必须唯一");
});

test("未知 device_sid 的 auth_init 被拒为 AUTH_FAILED", () => {
  const core = newCore();
  const conn = new FakeConn("terminal");
  core.handleConnect(conn);
  core.handleMessage(
    conn,
    JSON.stringify({
      type: "auth_init",
      role: "terminal",
      device_sid: "nonexistent-sid",
      meta: { platform: "test", version: "1", name: "t" },
      client_ts: 1,
    }),
  );

  assert.equal(conn.ofType("error").at(-1)?.["code"], "AUTH_FAILED");
  assert.equal(
    conn.ofType("auth_challenge").length,
    0,
    "会话不存在时不应发出挑战，避免泄露 sid 是否存在之外的信息",
  );
});

test("proof 错误被拒为 AUTH_FAILED", () => {
  const core = newCore();
  const { sid } = connectDevice(core, PASS_HASH);

  const conn = new FakeConn("terminal");
  core.handleConnect(conn);
  authenticateWithWrongProof(core, conn, sid, "terminal");

  assert.equal(conn.ofType("error").at(-1)?.["code"], "AUTH_FAILED");
  assert.equal(conn.ofType("auth_ack").length, 0, "失败时不得发 auth_ack");
});

test("角色不匹配的 proof 被拒（proof 与 role 绑定）", () => {
  const core = newCore();
  const { sid } = connectDevice(core, PASS_HASH);

  const conn = new FakeConn("terminal");
  core.handleConnect(conn);
  // 声明 terminal，却用 device 的角色串计算 proof
  authenticateWithWrongRole(core, conn, PASS_HASH, sid, "terminal", "device");

  assert.equal(conn.ofType("error").at(-1)?.["code"], "AUTH_FAILED");
});

test("未收到挑战就发 auth_response 被拒", () => {
  const core = newCore();
  const { sid } = connectDevice(core, PASS_HASH);
  const conn = new FakeConn("terminal");
  core.handleConnect(conn);
  core.handleMessage(
    conn,
    JSON.stringify({ type: "auth_response", device_sid: sid, proof: "x", client_ts: 1 }),
  );
  assert.equal(conn.ofType("error").at(-1)?.["code"], "AUTH_FAILED");
});

// ---------- 配对 ----------

test("终端接入后双方都收到 matched", () => {
  const core = newCore();
  const device = connectDevice(core, PASS_HASH);
  device.conn.clear();

  const terminal = connectTerminal(core, PASS_HASH, device.sid);

  assert.equal(terminal.conn.ofType("auth_ack").at(-1)?.["pair_status"], "matched");
  assert.equal(
    device.conn.ofType("pair_status_ack").at(-1)?.["pair_status"],
    "matched",
    "设备也必须被告知 matched",
  );
});

test("设备重连后必须立即收到 matched 而非 waiting", () => {
  const core = newCore();
  const device1 = connectDevice(core, PASS_HASH);
  const terminal = connectTerminal(core, PASS_HASH, device1.sid);

  // 设备断开：终端被告知 DEVICE_OFFLINE，会话保留
  core.handleClose(device1.conn);
  assert.equal(terminal.conn.ofType("error").at(-1)?.["code"], "DEVICE_OFFLINE");

  // 设备以 persisted 模式重连：直接 auth_init，不再注册
  const device2 = new FakeConn("device-reconnect");
  core.handleConnect(device2);
  authenticate(core, device2, PASS_HASH, device1.sid, "device");

  const ack = device2.ofType("auth_ack").at(-1);
  assert.equal(
    ack?.["pair_status"],
    "matched",
    "设备重连并认证成功后必须立即收到 matched，否则会判为陈旧并自行重连",
  );
  assert.equal(
    device2.ofType("pair_status_ack").length,
    0,
    "不得在 auth_ack 之外额外发送可能被判定为陈旧的 waiting",
  );

  // 终端也应恢复 matched
  assert.equal(terminal.conn.ofType("pair_status_ack").at(-1)?.["pair_status"], "matched");
});

test("第二终端抢占：旧终端收到 KICKED 并被关闭", () => {
  const core = newCore();
  const device = connectDevice(core, PASS_HASH);
  const t1 = connectTerminal(core, PASS_HASH, device.sid);

  const t2 = connectTerminal(core, PASS_HASH, device.sid);

  assert.equal(t1.conn.ofType("error").at(-1)?.["code"], "KICKED", "旧终端必须收到 KICKED");
  assert.equal(t1.conn.closed, true, "旧终端必须被关闭");
  assert.equal(t2.conn.closed, false, "新终端必须保持连接");

  // 新终端仍能正常通信
  const data = JSON.stringify({ type: "data", payload: { zcode_type: "bootstrap-request" }, client_ts: 1 });
  core.handleMessage(t2.conn, data);
  assert.equal(device.conn.sent.at(-1), data, "抢占后数据应路由到新终端");
});

test("设备离线时保留会话，终端可在宽限期内恢复", () => {
  const core = newCore();
  const device = connectDevice(core, PASS_HASH);
  const terminal = connectTerminal(core, PASS_HASH, device.sid);

  core.handleClose(device.conn);

  // 会话仍在：终端用同一 sid 重连不需要重新扫码
  const device2 = new FakeConn("device2");
  core.handleConnect(device2);
  authenticate(core, device2, PASS_HASH, device.sid, "device");
  assert.equal(device2.ofType("auth_ack").at(-1)?.["pair_status"], "matched");
  assert.equal(terminal.conn.closed, false);
});

test("终端离开后设备收到 waiting（状态真实反映配对情况）", () => {
  const core = newCore();
  const device = connectDevice(core, PASS_HASH);
  const terminal = connectTerminal(core, PASS_HASH, device.sid);
  device.conn.clear();

  core.handleClose(terminal.conn);

  assert.equal(device.conn.ofType("pair_status_ack").at(-1)?.["pair_status"], "waiting");
});

// ---------- 心跳 ----------

test("未配对时心跳返回 waiting，且可被任意状态应答", () => {
  const core = newCore();
  const device = connectDevice(core, PASS_HASH);
  device.conn.clear();

  sendHeartbeat(core, device.conn, device.sid);

  assert.equal(device.conn.ofType("pair_status_ack").at(-1)?.["pair_status"], "waiting");
});

test("配对后心跳返回 matched，且不产生多余推送（状态不振荡）", () => {
  const core = newCore();
  const device = connectDevice(core, PASS_HASH);
  const terminal = connectTerminal(core, PASS_HASH, device.sid);
  device.conn.clear();
  terminal.conn.clear();

  for (let i = 0; i < 3; i += 1) sendHeartbeat(core, device.conn, device.sid);

  assert.equal(device.conn.sent.length, 3, "三次心跳应恰有三条应答");
  for (const m of device.conn.ofType("pair_status_ack")) {
    assert.equal(m["pair_status"], "matched");
  }
  assert.equal(
    terminal.conn.sent.length,
    0,
    "设备心跳不得触发对终端的额外推送——每个 waiting 在设备侧都是破坏性的",
  );
});

test("未认证连接的心跳被静默忽略（不发 error 误杀客户端）", () => {
  const core = newCore();
  const conn = new FakeConn("stray");
  core.handleConnect(conn);

  sendHeartbeat(core, conn, "some-sid");

  assert.equal(conn.sent.length, 0, "不得发送任何消息");
});

test("sid 不符的心跳被忽略", () => {
  const core = newCore();
  const device = connectDevice(core, PASS_HASH);
  device.conn.clear();

  sendHeartbeat(core, device.conn, "different-sid");

  assert.equal(device.conn.sent.length, 0);
});

// ---------- 转发 ----------

test("载荷逐字节转发，不重排键序也不改数字格式", () => {
  const core = newCore();
  const device = connectDevice(core, PASS_HASH);
  const terminal = connectTerminal(core, PASS_HASH, device.sid);
  device.conn.clear();
  terminal.conn.clear();

  // 刻意加入空格与换行：若 relay 重新序列化，这些会被抹掉
  const raw = `{\n  "type": "data",\n  "payload": ${SAMPLE_RPC_FRAME},\n  "client_ts": 1234\n}`;
  core.handleMessage(device.conn, raw);

  assert.deepEqual(terminal.conn.sent, [raw], "必须逐字节相同");
});

test("反向转发同样逐字节", () => {
  const core = newCore();
  const device = connectDevice(core, PASS_HASH);
  const terminal = connectTerminal(core, PASS_HASH, device.sid);
  device.conn.clear();
  terminal.conn.clear();

  const raw = `{"type":"data","payload":{"zcode_type":"rpc-frame-ack","bridgeSessionId":"b","ackMessageSeq":7},"client_ts":9}`;
  core.handleMessage(terminal.conn, raw);

  assert.deepEqual(device.conn.sent, [raw]);
});

test("未配对时不转发 data", () => {
  const core = newCore();
  const device = connectDevice(core, PASS_HASH);
  device.conn.clear();

  const raw = JSON.stringify({ type: "data", payload: { zcode_type: "bootstrap-request" }, client_ts: 1 });
  core.handleMessage(device.conn, raw);

  assert.equal(device.conn.sent.length, 0, "无终端时不得有任何回显或转发");
});

test("未认证连接发送 data 被丢弃", () => {
  const core = newCore();
  const conn = new FakeConn("anon");
  core.handleConnect(conn);

  core.handleMessage(conn, JSON.stringify({ type: "data", payload: {}, client_ts: 1 }));

  assert.equal(conn.sent.length, 0);
});

test("超过 1MiB 的消息被丢弃", () => {
  const core = newCore();
  const device = connectDevice(core, PASS_HASH);
  const terminal = connectTerminal(core, PASS_HASH, device.sid);
  terminal.conn.clear();

  const oversized = `{"type":"data","payload":"${"x".repeat(MAX_PHYSICAL_FRAME_BYTES)}","client_ts":1}`;
  assert.ok(Buffer.byteLength(oversized, "utf8") > MAX_PHYSICAL_FRAME_BYTES);
  core.handleMessage(device.conn, oversized);

  assert.equal(terminal.conn.sent.length, 0, "超限消息不得转发");
});

test("格式非法的消息被丢弃且不断连", () => {
  const core = newCore();
  const device = connectDevice(core, PASS_HASH);
  const terminal = connectTerminal(core, PASS_HASH, device.sid);
  terminal.conn.clear();

  for (const bad of ["not json", "[]", "null", "{}", '{"type":"unknown-type"}', '{"type":123}']) {
    core.handleMessage(device.conn, bad);
  }

  assert.equal(terminal.conn.sent.length, 0);
  assert.equal(device.conn.closed, false, "不得因非法消息断连");
  assert.equal(terminal.conn.closed, false);
});

test("未知 code 不会被发明，error 只用协议定义的五个", () => {
  const core = newCore();
  const allowed = new Set(["AUTH_FAILED", "KICKED", "DEVICE_OFFLINE", "INTERNAL", "WRONG_PARAM"]);
  const seen: string[] = [];

  // 覆盖实现里所有会发出 error 的路径
  const cases: Array<() => FakeConn> = [
    // 未知 sid
    () => {
      const c = new FakeConn("t1");
      core.handleConnect(c);
      core.handleMessage(
        c,
        JSON.stringify({ type: "auth_init", role: "terminal", device_sid: "nope", meta: {}, client_ts: 1 }),
      );
      return c;
    },
    // 无待验证挑战
    () => {
      const c = new FakeConn("t2");
      core.handleConnect(c);
      core.handleMessage(
        c,
        JSON.stringify({ type: "auth_response", device_sid: "nope", proof: "x", client_ts: 1 }),
      );
      return c;
    },
    // proof 错误
    () => {
      const c = new FakeConn("t3");
      core.handleConnect(c);
      authenticateWithWrongProof(core, c, "any-sid", "terminal");
      return c;
    },
    // 设备断开导致终端收 DEVICE_OFFLINE；以及终端被抢占收 KICKED
    () => {
      const device = connectDevice(core, PASS_HASH);
      const t1 = connectTerminal(core, PASS_HASH, device.sid);
      connectTerminal(core, PASS_HASH, device.sid); // 抢占 t1
      core.handleClose(device.conn); // 触发 DEVICE_OFFLINE
      return t1.conn;
    },
  ];

  for (const run of cases) {
    const conn = run();
    for (const m of conn.ofType("error")) seen.push(String(m["code"]));
  }

  assert.ok(seen.length > 0, "本次运行应至少产生一个 error");
  for (const code of seen) {
    assert.ok(allowed.has(code), `未定义的 error code: ${code}`);
  }
});
