import { assert, assertEquals } from "@std/assert";

import { RelayCore } from "../src/relay/relay.ts";
import { calculateProof, derivePassHash } from "../src/protocol/crypto.ts";
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

const PASS_HASH = await derivePassHash("test-password");

function newCore(): RelayCore {
  return new RelayCore();
}

const META = { platform: "test", version: "1", name: "t" };

// ---------- 注册与认证 ----------

Deno.test("设备注册后得到唯一 device_sid 并进入 waiting", async () => {
  const core = newCore();
  const conn = new FakeConn("device");
  core.handleConnect(conn);

  await core.handleMessage(
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
  assert(ack, "必须返回 device_register_ack");
  const sid = String(ack["device_sid"]);
  assert(sid.length > 0);

  // 认证后无终端接入 → waiting
  await authenticate(core, conn, PASS_HASH, sid, "device");
  const authAck = conn.ofType("auth_ack").at(-1);
  assertEquals(authAck?.["pair_status"], "waiting", "无终端时应为 waiting");
});

Deno.test("两次注册得到不同的 device_sid", async () => {
  const core = newCore();
  const sids = new Set<string>();
  for (let i = 0; i < 2; i += 1) {
    const conn = new FakeConn("device");
    core.handleConnect(conn);
    await core.handleMessage(
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
  assertEquals(sids.size, 2, "device_sid 必须唯一");
});

Deno.test("未知 device_sid 的 auth_init 被拒为 AUTH_FAILED", async () => {
  const core = newCore();
  const conn = new FakeConn("terminal");
  core.handleConnect(conn);
  await core.handleMessage(
    conn,
    JSON.stringify({
      type: "auth_init",
      role: "terminal",
      device_sid: "nonexistent-sid",
      meta: META,
      client_ts: 1,
    }),
  );

  assertEquals(conn.ofType("error").at(-1)?.["code"], "AUTH_FAILED");
  assertEquals(
    conn.ofType("auth_challenge").length,
    0,
    "会话不存在时不应发出挑战，避免泄露 sid 是否存在之外的信息",
  );
});

Deno.test("proof 错误被拒为 AUTH_FAILED", async () => {
  const core = newCore();
  const { sid } = await connectDevice(core, PASS_HASH);

  const conn = new FakeConn("terminal");
  core.handleConnect(conn);
  await authenticateWithWrongProof(core, conn, sid, "terminal");

  assertEquals(conn.ofType("error").at(-1)?.["code"], "AUTH_FAILED");
  assertEquals(conn.ofType("auth_ack").length, 0, "失败时不得发 auth_ack");
});

Deno.test("角色不匹配的 proof 被拒（proof 与 role 绑定）", async () => {
  const core = newCore();
  const { sid } = await connectDevice(core, PASS_HASH);

  const conn = new FakeConn("terminal");
  core.handleConnect(conn);
  // 声明 terminal，却用 device 的角色串计算 proof
  await authenticateWithWrongRole(core, conn, PASS_HASH, sid, "terminal", "device");

  assertEquals(conn.ofType("error").at(-1)?.["code"], "AUTH_FAILED");
});

Deno.test("未收到挑战就发 auth_response 被拒", async () => {
  const core = newCore();
  const { sid } = await connectDevice(core, PASS_HASH);
  const conn = new FakeConn("terminal");
  core.handleConnect(conn);
  await core.handleMessage(
    conn,
    JSON.stringify({ type: "auth_response", device_sid: sid, proof: "x", client_ts: 1 }),
  );
  assertEquals(conn.ofType("error").at(-1)?.["code"], "AUTH_FAILED");
});

Deno.test("同一连接上连续两条 auth_response 按到达顺序处理，后到者不得插队", async () => {
  // 认证校验是异步的（Web Crypto 无同步 HMAC）。若不在连接上串行化，
  // 第二条会在第一条附着之前被判成"无待验证挑战"，AUTH_FAILED 就会插到
  // auth_ack 前面——而 AUTH_FAILED 对客户端是致命的。
  const core = newCore();
  const { sid } = await connectDevice(core, PASS_HASH);

  const conn = new FakeConn("terminal");
  core.handleConnect(conn);
  await core.handleMessage(
    conn,
    JSON.stringify({
      type: "auth_init",
      role: "terminal",
      device_sid: sid,
      meta: META,
      client_ts: 1,
    }),
  );
  const nonce = String(conn.ofType("auth_challenge").at(-1)?.["nonce"]);
  const frame = JSON.stringify({
    type: "auth_response",
    device_sid: sid,
    proof: await calculateProof(PASS_HASH, nonce, "terminal", sid),
    client_ts: 1,
  });
  conn.clear();

  const first = core.handleMessage(conn, frame);
  const second = core.handleMessage(conn, frame);
  await Promise.all([first, second]);

  assertEquals(conn.types(), ["auth_ack", "error"], "必须先回 auth_ack，再回重复应答的错误");
  assertEquals(conn.ofType("auth_ack").at(-1)?.["pair_status"], "matched");
  assertEquals(conn.ofType("error").at(-1)?.["code"], "AUTH_FAILED");
});

Deno.test("认证校验期间断开：不得附着会话，也不得把状态推成 matched", async () => {
  const core = newCore();
  const device = await connectDevice(core, PASS_HASH);
  device.conn.clear();

  const conn = new FakeConn("terminal");
  core.handleConnect(conn);
  await core.handleMessage(
    conn,
    JSON.stringify({
      type: "auth_init",
      role: "terminal",
      device_sid: device.sid,
      meta: META,
      client_ts: 1,
    }),
  );
  const nonce = String(conn.ofType("auth_challenge").at(-1)?.["nonce"]);

  // 不 await：此刻校验挂在 await 上，正是"校验期间断开"的窗口
  const inFlight = core.handleMessage(
    conn,
    JSON.stringify({
      type: "auth_response",
      device_sid: device.sid,
      proof: await calculateProof(PASS_HASH, nonce, "terminal", device.sid),
      client_ts: 1,
    }),
  );
  conn.close();
  core.handleClose(conn);
  await inFlight;

  assertEquals(conn.ofType("auth_ack").length, 0, "断开的连接不得收到 auth_ack");
  assertEquals(
    device.conn.ofType("pair_status_ack").length,
    0,
    "不得因为一次已断开的认证把设备推成 matched",
  );

  // 会话状态必须仍是 waiting：设备心跳应回 waiting
  await sendHeartbeat(core, device.conn, device.sid);
  assertEquals(device.conn.ofType("pair_status_ack").at(-1)?.["pair_status"], "waiting");
});

// ---------- 配对 ----------

Deno.test("终端接入后双方都收到 matched", async () => {
  const core = newCore();
  const device = await connectDevice(core, PASS_HASH);
  device.conn.clear();

  const terminal = await connectTerminal(core, PASS_HASH, device.sid);

  assertEquals(terminal.conn.ofType("auth_ack").at(-1)?.["pair_status"], "matched");
  assertEquals(
    device.conn.ofType("pair_status_ack").at(-1)?.["pair_status"],
    "matched",
    "设备也必须被告知 matched",
  );
});

Deno.test("设备重连后必须立即收到 matched 而非 waiting", async () => {
  const core = newCore();
  const device1 = await connectDevice(core, PASS_HASH);
  const terminal = await connectTerminal(core, PASS_HASH, device1.sid);

  // 设备断开：终端被告知 DEVICE_OFFLINE，会话保留
  core.handleClose(device1.conn);
  assertEquals(terminal.conn.ofType("error").at(-1)?.["code"], "DEVICE_OFFLINE");

  // 设备以 persisted 模式重连：直接 auth_init，不再注册
  const device2 = new FakeConn("device-reconnect");
  core.handleConnect(device2);
  await authenticate(core, device2, PASS_HASH, device1.sid, "device");

  const ack = device2.ofType("auth_ack").at(-1);
  assertEquals(
    ack?.["pair_status"],
    "matched",
    "设备重连并认证成功后必须立即收到 matched，否则会判为陈旧并自行重连",
  );
  assertEquals(
    device2.ofType("pair_status_ack").length,
    0,
    "不得在 auth_ack 之外额外发送可能被判定为陈旧的 waiting",
  );

  // 终端也应恢复 matched
  assertEquals(terminal.conn.ofType("pair_status_ack").at(-1)?.["pair_status"], "matched");
});

Deno.test("第二终端抢占：旧终端收到 KICKED 并被关闭", async () => {
  const core = newCore();
  const device = await connectDevice(core, PASS_HASH);
  const t1 = await connectTerminal(core, PASS_HASH, device.sid);

  const t2 = await connectTerminal(core, PASS_HASH, device.sid);

  assertEquals(t1.conn.ofType("error").at(-1)?.["code"], "KICKED", "旧终端必须收到 KICKED");
  assertEquals(t1.conn.closed, true, "旧终端必须被关闭");
  assertEquals(t2.conn.closed, false, "新终端必须保持连接");

  // 新终端仍能正常通信
  const data = JSON.stringify({
    type: "data",
    payload: { zcode_type: "bootstrap-request" },
    client_ts: 1,
  });
  await core.handleMessage(t2.conn, data);
  assertEquals(device.conn.sent.at(-1), data, "抢占后数据应路由到新终端");
});

Deno.test("设备离线时保留会话，终端可在宽限期内恢复", async () => {
  const core = newCore();
  const device = await connectDevice(core, PASS_HASH);
  const terminal = await connectTerminal(core, PASS_HASH, device.sid);

  core.handleClose(device.conn);

  // 会话仍在：终端用同一 sid 重连不需要重新扫码
  const device2 = new FakeConn("device2");
  core.handleConnect(device2);
  await authenticate(core, device2, PASS_HASH, device.sid, "device");
  assertEquals(device2.ofType("auth_ack").at(-1)?.["pair_status"], "matched");
  assertEquals(terminal.conn.closed, false);
});

Deno.test("终端离开后设备收到 waiting（状态真实反映配对情况）", async () => {
  const core = newCore();
  const device = await connectDevice(core, PASS_HASH);
  const terminal = await connectTerminal(core, PASS_HASH, device.sid);
  device.conn.clear();

  core.handleClose(terminal.conn);

  assertEquals(device.conn.ofType("pair_status_ack").at(-1)?.["pair_status"], "waiting");
});

// ---------- 心跳 ----------

Deno.test("未配对时心跳返回 waiting，且可被任意状态应答", async () => {
  const core = newCore();
  const device = await connectDevice(core, PASS_HASH);
  device.conn.clear();

  await sendHeartbeat(core, device.conn, device.sid);

  assertEquals(device.conn.ofType("pair_status_ack").at(-1)?.["pair_status"], "waiting");
});

Deno.test("配对后心跳返回 matched，且不产生多余推送（状态不振荡）", async () => {
  const core = newCore();
  const device = await connectDevice(core, PASS_HASH);
  const terminal = await connectTerminal(core, PASS_HASH, device.sid);
  device.conn.clear();
  terminal.conn.clear();

  for (let i = 0; i < 3; i += 1) await sendHeartbeat(core, device.conn, device.sid);

  assertEquals(device.conn.sent.length, 3, "三次心跳应恰有三条应答");
  for (const m of device.conn.ofType("pair_status_ack")) {
    assertEquals(m["pair_status"], "matched");
  }
  assertEquals(
    terminal.conn.sent.length,
    0,
    "设备心跳不得触发对终端的额外推送——每个 waiting 在设备侧都是破坏性的",
  );
});

Deno.test("未认证连接的心跳被静默忽略（不发 error 误杀客户端）", async () => {
  const core = newCore();
  const conn = new FakeConn("stray");
  core.handleConnect(conn);

  await sendHeartbeat(core, conn, "some-sid");

  assertEquals(conn.sent.length, 0, "不得发送任何消息");
});

Deno.test("sid 不符的心跳被忽略", async () => {
  const core = newCore();
  const device = await connectDevice(core, PASS_HASH);
  device.conn.clear();

  await sendHeartbeat(core, device.conn, "different-sid");

  assertEquals(device.conn.sent.length, 0);
});

// ---------- 转发 ----------

Deno.test("载荷逐字节转发，不重排键序也不改数字格式", async () => {
  const core = newCore();
  const device = await connectDevice(core, PASS_HASH);
  const terminal = await connectTerminal(core, PASS_HASH, device.sid);
  device.conn.clear();
  terminal.conn.clear();

  // 刻意加入空格与换行：若 relay 重新序列化，这些会被抹掉
  const raw = `{\n  "type": "data",\n  "payload": ${SAMPLE_RPC_FRAME},\n  "client_ts": 1234\n}`;
  await core.handleMessage(device.conn, raw);

  assertEquals(terminal.conn.sent, [raw], "必须逐字节相同");
});

Deno.test("反向转发同样逐字节", async () => {
  const core = newCore();
  const device = await connectDevice(core, PASS_HASH);
  const terminal = await connectTerminal(core, PASS_HASH, device.sid);
  device.conn.clear();
  terminal.conn.clear();

  const raw =
    `{"type":"data","payload":{"zcode_type":"rpc-frame-ack","bridgeSessionId":"b","ackMessageSeq":7},"client_ts":9}`;
  await core.handleMessage(terminal.conn, raw);

  assertEquals(device.conn.sent, [raw]);
});

Deno.test("接近帧上限的大帧逐字节转发（走头部扫描快路径）", async () => {
  const core = newCore();
  const device = await connectDevice(core, PASS_HASH);
  const terminal = await connectTerminal(core, PASS_HASH, device.sid);
  device.conn.clear();
  terminal.conn.clear();

  // 大帧走的是只扫描头部、不解析 payload 的快路径，因此这里专门钉住
  // 「原文一字不改」这条不变式（design.md §3 不变式 1、protocol.md §10.14）。
  const raw = `{"type":"data","payload":{"zcode_type":"rpc-frame","dataBase64":"${
    "A".repeat(
      512 * 1024,
    )
  }"},"client_ts":1234}`;
  await core.handleMessage(device.conn, raw);

  assertEquals(terminal.conn.sent, [raw], "大帧必须逐字节相同");
});

Deno.test("未配对时不转发 data", async () => {
  const core = newCore();
  const device = await connectDevice(core, PASS_HASH);
  device.conn.clear();

  const raw = JSON.stringify({
    type: "data",
    payload: { zcode_type: "bootstrap-request" },
    client_ts: 1,
  });
  await core.handleMessage(device.conn, raw);

  assertEquals(device.conn.sent.length, 0, "无终端时不得有任何回显或转发");
});

Deno.test("未认证连接发送 data 被丢弃", async () => {
  const core = newCore();
  const conn = new FakeConn("anon");
  core.handleConnect(conn);

  await core.handleMessage(conn, JSON.stringify({ type: "data", payload: {}, client_ts: 1 }));

  assertEquals(conn.sent.length, 0);
});

Deno.test("超过 1MiB 的消息被丢弃", async () => {
  const core = newCore();
  const device = await connectDevice(core, PASS_HASH);
  const terminal = await connectTerminal(core, PASS_HASH, device.sid);
  terminal.conn.clear();

  const oversized = `{"type":"data","payload":"${
    "x".repeat(MAX_PHYSICAL_FRAME_BYTES)
  }","client_ts":1}`;
  assert(new TextEncoder().encode(oversized).byteLength > MAX_PHYSICAL_FRAME_BYTES);
  await core.handleMessage(device.conn, oversized);

  assertEquals(terminal.conn.sent.length, 0, "超限消息不得转发");
});

Deno.test("格式非法的消息被丢弃且不断连", async () => {
  const core = newCore();
  const device = await connectDevice(core, PASS_HASH);
  const terminal = await connectTerminal(core, PASS_HASH, device.sid);
  terminal.conn.clear();

  for (const bad of ["not json", "[]", "null", "{}", '{"type":"unknown-type"}', '{"type":123}']) {
    await core.handleMessage(device.conn, bad);
  }

  assertEquals(terminal.conn.sent.length, 0);
  assertEquals(device.conn.closed, false, "不得因非法消息断连");
  assertEquals(terminal.conn.closed, false);
});

Deno.test("未知 code 不会被发明，error 只用协议定义的五个", async () => {
  const core = newCore();
  const allowed = new Set(["AUTH_FAILED", "KICKED", "DEVICE_OFFLINE", "INTERNAL", "WRONG_PARAM"]);
  const seen: string[] = [];

  // 覆盖实现里所有会发出 error 的路径
  const cases: Array<() => Promise<FakeConn>> = [
    // 未知 sid
    async () => {
      const c = new FakeConn("t1");
      core.handleConnect(c);
      await core.handleMessage(
        c,
        JSON.stringify({
          type: "auth_init",
          role: "terminal",
          device_sid: "nope",
          meta: {},
          client_ts: 1,
        }),
      );
      return c;
    },
    // 无待验证挑战
    async () => {
      const c = new FakeConn("t2");
      core.handleConnect(c);
      await core.handleMessage(
        c,
        JSON.stringify({ type: "auth_response", device_sid: "nope", proof: "x", client_ts: 1 }),
      );
      return c;
    },
    // proof 错误
    async () => {
      const c = new FakeConn("t3");
      core.handleConnect(c);
      await authenticateWithWrongProof(core, c, "any-sid", "terminal");
      return c;
    },
    // 设备断开导致终端收 DEVICE_OFFLINE；以及终端被抢占收 KICKED
    async () => {
      const device = await connectDevice(core, PASS_HASH);
      const t1 = await connectTerminal(core, PASS_HASH, device.sid);
      await connectTerminal(core, PASS_HASH, device.sid); // 抢占 t1
      core.handleClose(device.conn); // 触发 DEVICE_OFFLINE
      return t1.conn;
    },
  ];

  for (const run of cases) {
    const conn = await run();
    for (const m of conn.ofType("error")) seen.push(String(m["code"]));
  }

  assert(seen.length > 0, "本次运行应至少产生一个 error");
  for (const code of seen) {
    assert(allowed.has(code), `未定义的 error code: ${code}`);
  }
});
