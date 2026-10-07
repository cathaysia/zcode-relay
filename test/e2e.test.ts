import { test } from "node:test";
import assert from "node:assert/strict";

import { RelayServer } from "../src/relay/server.ts";
import { derivePassHash } from "../src/protocol/crypto.ts";
import { MAX_PHYSICAL_FRAME_BYTES } from "../src/protocol/limits.ts";
import {
  connectTerminal,
  reconnectDevice,
  registerDevice,
  SimClient,
} from "./helpers/sim-client.ts";

const PASS_HASH = derivePassHash("e2e-test-password");
const SILENT = { info: () => {}, warn: () => {} };

interface Harness {
  readonly url: string;
  readonly server: RelayServer;
}

async function startRelay(): Promise<Harness> {
  const server = new RelayServer({ host: "127.0.0.1", port: 0, path: "/ws", logger: SILENT });
  const address = await server.listen();
  return { url: `ws://127.0.0.1:${address.port}/ws`, server };
}

/** 每条用例独立起一个 relay，避免状态串扰。 */
async function withRelay<T>(fn: (h: Harness) => Promise<T>): Promise<T> {
  const h = await startRelay();
  try {
    return await fn(h);
  } finally {
    await h.server.close();
  }
}

test("端到端：完整握手，设备注册后 waiting，终端接入后双方 matched", async () => {
  await withRelay(async ({ url }) => {
    const device = await registerDevice(url, PASS_HASH, "mid-e2e-1");
    assert.ok(device.deviceSid.length > 0);
    assert.equal(
      (await device.client.expectPairStatus("waiting"))["pair_status"],
      "waiting",
      "无终端时应为 waiting",
    );

    const terminal = await connectTerminal(url, PASS_HASH, device.deviceSid);

    assert.equal((await terminal.expectPairStatus("matched"))["pair_status"], "matched");
    await device.client.expectPairStatus("matched");

    await device.client.close();
    await terminal.close();
  });
});

test("端到端：载荷跨 relay 传输保持字节级不变", async () => {
  await withRelay(async ({ url }) => {
    const device = await registerDevice(url, PASS_HASH, "mid-e2e-2");
    const terminal = await connectTerminal(url, PASS_HASH, device.deviceSid);
    await device.client.expectPairStatus("matched");
    await terminal.expectPairStatus("matched");
    terminal.clear();

    // 刻意包含空格与换行，以及未知嵌套字段
    const raw =
      `{\n  "type": "data",\n  "payload": {"zcode_type":"rpc-frame","bridgeSessionId":"b1",` +
      `"seq":1,"messageSeq":1,"fragmentIndex":0,"fragmentCount":1,"messageBytes":4,` +
      `"checksum":{"algorithm":"crc32","value":"00000000"},"dataBase64":"AAAAAA==",` +
      `"unknownFutureField":{"nested":[1,2,{"deep":true}]}},\n  "client_ts": 42\n}`;
    device.client.sendRaw(raw);

    const msg = await terminal.expectType("data", 2_000);
    assert.equal(msg["type"], "data");
    assert.equal(
      terminal.rawReceived[terminal.rawReceived.length - 1],
      raw,
      "relay 必须逐字节转发，不得重排键序或改写空白",
    );

    await device.client.close();
    await terminal.close();
  });
});

test("端到端：心跳往返返回 matched", async () => {
  await withRelay(async ({ url }) => {
    const device = await registerDevice(url, PASS_HASH, "mid-e2e-3");
    const terminal = await connectTerminal(url, PASS_HASH, device.deviceSid);
    await device.client.expectPairStatus("matched");
    await terminal.expectPairStatus("matched");

    device.client.clear();
    device.client.send({ type: "pair_status_query", device_sid: device.deviceSid, client_ts: Date.now() });

    assert.equal((await device.client.expectPairStatus("matched"))["pair_status"], "matched");

    await device.client.close();
    await terminal.close();
  });
});

test("端到端：设备掉线后终端收到 DEVICE_OFFLINE，设备重连后恢复 matched", async () => {
  await withRelay(async ({ url }) => {
    const device = await registerDevice(url, PASS_HASH, "mid-e2e-4");
    const terminal = await connectTerminal(url, PASS_HASH, device.deviceSid);
    await device.client.expectPairStatus("matched");
    await terminal.expectPairStatus("matched");

    device.client.terminate();
    await terminal.expectError("DEVICE_OFFLINE");
    terminal.clear();

    // 同一 device_sid 重连（persisted 模式，不再注册）
    const device2 = await reconnectDevice(url, PASS_HASH, device.deviceSid, "mid-e2e-4");
    const status = await device2.expectPairStatus("matched");
    assert.equal(
      status["pair_status"],
      "matched",
      "重连认证成功后必须立刻得到 matched，否则设备会判为陈旧并自行重连",
    );
    assert.equal(status["type"], "auth_ack");
    await terminal.expectPairStatus("matched");

    await device2.close();
    await terminal.close();
  });
});

test("端到端：第二终端抢占，旧终端收 KICKED 且连接被关闭", async () => {
  await withRelay(async ({ url }) => {
    const device = await registerDevice(url, PASS_HASH, "mid-e2e-5");
    const t1 = await connectTerminal(url, PASS_HASH, device.deviceSid);
    await t1.expectPairStatus("matched");

    const t2 = await connectTerminal(url, PASS_HASH, device.deviceSid);

    await t1.expectError("KICKED");
    await new Promise((r) => setTimeout(r, 150));
    assert.equal(t1.closed, true, "旧终端连接必须被关闭");

    // 新终端接管通信
    t2.clear();
    device.client.clear();
    const raw = JSON.stringify({
      type: "data",
      payload: { zcode_type: "bootstrap-request", requestId: "r1" },
      client_ts: 7,
    });
    t2.sendRaw(raw);
    await device.client.expectType("data");
    assert.equal(device.client.rawReceived.at(-1), raw);

    await device.client.close();
    await t2.close();
  });
});

test("端到端：未知 device_sid 认证失败", async () => {
  await withRelay(async ({ url }) => {
    const client = await SimClient.open(`${url}?mid=x`, "terminal");
    client.send({
      type: "auth_init",
      role: "terminal",
      device_sid: "does-not-exist",
      meta: { platform: "web", version: "t", name: "n" },
      client_ts: 1,
    });
    assert.equal((await client.expectError("AUTH_FAILED"))["code"], "AUTH_FAILED");
    await client.close();
  });
});

test("端到端：错误 proof 认证失败", async () => {
  await withRelay(async ({ url }) => {
    const device = await registerDevice(url, PASS_HASH, "mid-e2e-6");

    const client = await SimClient.open(`${url}?mid=y`, "terminal");
    client.send({
      type: "auth_init",
      role: "terminal",
      device_sid: device.deviceSid,
      meta: { platform: "web", version: "t", name: "n" },
      client_ts: 1,
    });
    const challenge = await client.expectType("auth_challenge");
    client.send({
      type: "auth_response",
      device_sid: device.deviceSid,
      proof: "wrong-proof-value",
      client_ts: 1,
    });

    await client.expectError("AUTH_FAILED");
    await device.client.close();
    await client.close();
  });
});

test("端到端：无终端时数据不转发也不回显", async () => {
  await withRelay(async ({ url }) => {
    const device = await registerDevice(url, PASS_HASH, "mid-e2e-7");
    await device.client.expectPairStatus("waiting");
    device.client.clear();

    device.client.sendRaw(
      JSON.stringify({ type: "data", payload: { zcode_type: "bootstrap-request" }, client_ts: 1 }),
    );

    await device.client.expectSilence(300);
    await device.client.close();
  });
});

test("端到端：relay 重启后旧 device_sid 失效，设备收到 AUTH_FAILED 可自愈重注册", async () => {
  const first = await startRelay();
  const device = await registerDevice(first.url, PASS_HASH, "mid-e2e-8");
  await first.server.close();

  // 新实例不持有任何会话（pass_hash 不落盘）
  const second = await startRelay();
  try {
    const client = await SimClient.open(`${second.url}?mid=mid-e2e-8`, "device", {
      "X-Device-ID": "mid-e2e-8",
    });
    client.send({
      type: "auth_init",
      role: "device",
      device_sid: device.deviceSid,
      meta: { platform: "linux", version: "t", name: "d" },
      client_ts: 1,
    });
    await client.expectError("AUTH_FAILED");

    // 自愈路径：设备清本地凭据后以同一 pass_hash 重新注册
    client.send({
      type: "device_register_init",
      device_mid: "mid-e2e-8",
      pass_hash: PASS_HASH,
      meta: { platform: "linux", version: "t", name: "d" },
      client_ts: 2,
    });
    const ack = await client.expectType("device_register_ack");
    assert.notEqual(String(ack["device_sid"]), device.deviceSid, "必须颁发新的 device_sid");
    await client.close();
  } finally {
    await second.server.close();
  }
});

test("端到端：超过 1MiB 的帧被拒绝", async () => {
  await withRelay(async ({ url }) => {
    const device = await registerDevice(url, PASS_HASH, "mid-e2e-9");
    const oversized = JSON.stringify({
      type: "data",
      payload: { zcode_type: "rpc-frame", dataBase64: "A".repeat(MAX_PHYSICAL_FRAME_BYTES) },
      client_ts: 1,
    });
    assert.ok(Buffer.byteLength(oversized, "utf8") > MAX_PHYSICAL_FRAME_BYTES);

    device.client.sendRaw(oversized);
    // 合规客户端不会发出超限帧；此处 relay 在 ws 层拒绝，连接关闭
    await new Promise((r) => setTimeout(r, 300));
    assert.equal(device.client.closed, true, "超限帧应导致连接被拒绝");
  });
});

test("端到端：非法 JSON 被丢弃且不断连", async () => {
  await withRelay(async ({ url }) => {
    const device = await registerDevice(url, PASS_HASH, "mid-e2e-10");
    await device.client.expectPairStatus("waiting");
    device.client.clear();

    for (const bad of ["not json at all", "[1,2,3]", '"a string"', "{}"]) {
      device.client.sendRaw(bad);
    }
    device.client.send({ type: "pair_status_query", device_sid: device.deviceSid, client_ts: 1 });

    // 连接仍可用：心跳得到应答
    await device.client.expectPairStatus("waiting");
    assert.equal(device.client.closed, false);
    await device.client.close();
  });
});
