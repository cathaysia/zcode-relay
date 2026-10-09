/**
 * 入站解析的单元测试。重点是 data 帧的快路径与回退路径的边界：
 * 快路径必须逐字节保留原文，且不得绕过长度上限；扫不到 type 时必须
 * 回退到完整解析，语义与改动前一致。
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import { parseInbound } from "../src/protocol/messages.ts";
import { MAX_PHYSICAL_FRAME_BYTES } from "../src/protocol/limits.ts";

const DATA_PREFIX = '{"type":"data","payload":"';
const DATA_SUFFIX = '","client_ts":1}';

/** 构造一条 payload 为 payloadChars 个 'A' 的 data 报文。 */
function dataFrame(payloadChars: number): string {
  return `${DATA_PREFIX}${"A".repeat(payloadChars)}${DATA_SUFFIX}`;
}

/** 断言解析结果是一条 data，且原始文本逐字节未被改动。 */
function assertDataPreserved(raw: string): void {
  const msg = parseInbound(raw);
  assert.equal(msg?.type, "data");
  assert.equal(msg?.type === "data" ? msg.raw : null, raw);
}

// ---------- data 帧：快路径 ----------

test("data 帧原样返回，raw 与输入逐字节相同", () => {
  assertDataPreserved(dataFrame(0));
});

test("大帧同样逐字节保留，内容不被规范化", () => {
  // 键序、数字格式与嵌套结构全部必须原样保留
  const payload = JSON.stringify({
    z: 1,
    a: 2,
    nested: { deep: [1, 2, 3] },
    num: 1.0e3,
    pad: "B".repeat(256 * 1024),
  });
  assertDataPreserved(`{"type":"data","payload":${payload},"client_ts":1234}`);
});

test("type 不在首位时回退完整解析，仍识别为 data", () => {
  assertDataPreserved('{"seq":1,"type":"data","payload":{"a":1}}');
});

test("信封含空白时仍能识别 data", () => {
  assert.equal(parseInbound('{ "type" : "data" , "payload" : 1 }')?.type, "data");
});

test("type 值写成 JSON 转义时回退完整解析，仍识别为 data", () => {
  // 头部扫描看到的是字面量 \u0064ata，不是 data，故必须回退
  assert.equal(parseInbound('{"type":"\\u0064ata","payload":1}')?.type, "data");
});

test("头部像 data 但整体非法的报文被放行——不解析 payload 的代价，见 docs/protocol.md §11", () => {
  // 这两条报文 JSON.parse 都会失败。它们能返回非 null 只可能来自快路径，
  // 因此该用例同时证明快路径确实被命中，而非碰巧结果等价。
  assertDataPreserved('{"type":"data", this is not valid json');
  assertDataPreserved('{"type":"data"');
});

// ---------- data 帧：长度上限 ----------

test("超限的 data 帧被拒绝，快路径不得绕过上限", () => {
  const raw = dataFrame(MAX_PHYSICAL_FRAME_BYTES);
  assert.equal(Buffer.byteLength(raw, "utf8") > MAX_PHYSICAL_FRAME_BYTES, true);
  assert.equal(parseInbound(raw), null);
});

test("恰好等于上限的 data 帧被接受（上限为闭区间）", () => {
  const overhead = DATA_PREFIX.length + DATA_SUFFIX.length;
  const raw = dataFrame(MAX_PHYSICAL_FRAME_BYTES - overhead);

  assert.equal(Buffer.byteLength(raw, "utf8"), MAX_PHYSICAL_FRAME_BYTES);
  assertDataPreserved(raw);
});

test("多字节字符按 UTF-8 字节数计算，而非字符数", () => {
  // 字符数远小于上限，但字节数超限，必须按字节拒绝
  const raw = dataFrame(0).replace('""', `"${"中".repeat(MAX_PHYSICAL_FRAME_BYTES / 2)}"`);
  assert.equal(Buffer.byteLength(raw, "utf8") > MAX_PHYSICAL_FRAME_BYTES, true);
  assert.equal(parseInbound(raw), null);
});

// ---------- control 帧：完整解析路径不受影响 ----------

test("控制类消息仍走完整解析并校验必填字段", () => {
  const query = parseInbound('{"type":"pair_status_query","device_sid":"sid-1"}');
  assert.equal(query?.type, "pair_status_query");
  assert.equal(query?.type === "pair_status_query" ? query.deviceSid : null, "sid-1");

  const auth = parseInbound('{"type":"auth_response","device_sid":"sid-1","proof":"p"}');
  assert.equal(auth?.type, "auth_response");
  assert.equal(auth?.type === "auth_response" ? auth.proof : null, "p");

  const init = parseInbound(
    '{"type":"auth_init","role":"terminal","device_sid":"sid-1","meta":{"platform":"test","version":"1","name":"n"}}',
  );
  assert.equal(init?.type, "auth_init");
  assert.equal(init?.type === "auth_init" ? init.role : null, "terminal");
});

test("控制类消息缺字段仍被拒绝", () => {
  assert.equal(parseInbound('{"type":"auth_response","device_sid":"sid-1"}'), null);
  assert.equal(parseInbound('{"type":"pair_status_query"}'), null);
  assert.equal(parseInbound('{"type":"auth_init","role":"nobody","device_sid":"s"}'), null);
  assert.equal(parseInbound('{"type":"device_register_init","device_mid":"m"}'), null);
});

test("体积很大的控制类消息不会被快路径误判", () => {
  const raw = `{"type":"auth_response","device_sid":"s","proof":"p","pad":"${"C".repeat(
    256 * 1024,
  )}"}`;
  const msg = parseInbound(raw);

  assert.equal(msg?.type, "auth_response");
  assert.equal(msg?.type === "auth_response" ? msg.deviceSid : null, "s");
});

// ---------- 非法消息：既有行为不变 ----------

test("无法识别的报文仍被丢弃", () => {
  const rejected = [
    "not json",
    "[]",
    "null",
    "{}",
    '{"type":"unknown-type"}',
    '{"type":123}',
  ];
  for (const raw of rejected) {
    assert.equal(parseInbound(raw), null, `应被丢弃: ${raw}`);
  }
});
