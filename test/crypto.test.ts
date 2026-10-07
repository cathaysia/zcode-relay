import { test } from "node:test";
import assert from "node:assert/strict";

import {
  calculateProof,
  createDeviceSid,
  createNonce,
  createPassword,
  derivePassHash,
  verifyProof,
} from "../src/protocol/crypto.ts";

test("createPassword 产出 32 字符的 base64url", () => {
  const pw = createPassword();
  assert.equal(pw.length, 32);
  assert.match(pw, /^[A-Za-z0-9_-]+$/);
  // 24 字节随机 → 每次不同
  assert.notEqual(pw, createPassword());
});

test("derivePassHash 是标准 base64 且带 '=' 填充", () => {
  const hash = derivePassHash("some-password");
  // sha256 = 32 字节 → base64 44 字符，末尾一个 '='
  assert.equal(hash.length, 44);
  assert.ok(hash.endsWith("="), `expected '=' padding, got ${hash}`);
  assert.match(hash, /^[A-Za-z0-9+/]+={0,2}$/);
  // 与直接计算一致
  assert.equal(hash, derivePassHash("some-password"));
});

test("calculateProof 是 base64url 且无填充", () => {
  const proof = calculateProof("hash", "nonce", "device", "sid");
  assert.ok(!proof.includes("="), `proof 不应含填充: ${proof}`);
  assert.ok(!proof.includes("+"), `proof 不应含 '+': ${proof}`);
  assert.ok(!proof.includes("/"), `proof 不应含 '/': ${proof}`);
  assert.match(proof, /^[A-Za-z0-9_-]+$/);
});

test("calculateProof 与 role 绑定", () => {
  const args = ["hash", "nonce", "sid"] as const;
  const asDevice = calculateProof(args[0], args[1], "device", args[2]);
  const asTerminal = calculateProof(args[0], args[1], "terminal", args[2]);
  assert.notEqual(asDevice, asTerminal, "role 必须参与证明计算");
});

test("calculateProof 与 nonce 和 sid 绑定", () => {
  const base = calculateProof("h", "n1", "device", "s1");
  assert.notEqual(base, calculateProof("h", "n2", "device", "s1"));
  assert.notEqual(base, calculateProof("h", "n1", "device", "s2"));
  assert.notEqual(base, calculateProof("h2", "n1", "device", "s1"));
});

test("calculateProof 与手工 HMAC 计算一致", async () => {
  const { createHmac } = await import("node:crypto");
  const expected = createHmac("sha256", "the-hash")
    .update("the-nonce|device|the-sid")
    .digest("base64url");
  assert.equal(calculateProof("the-hash", "the-nonce", "device", "the-sid"), expected);
});

test("verifyProof 正确与错误情形", () => {
  const proof = calculateProof("h", "n", "device", "s");
  assert.equal(verifyProof(proof, proof), true);
  assert.equal(verifyProof(proof, `${proof}x`), false, "长度不同必须为 false");
  assert.equal(verifyProof(proof, "short"), false);
  assert.equal(verifyProof(proof, proof.slice(0, -1) + "A"), false);
});

test("createDeviceSid 与 createNonce 是 URL 安全的唯一值", () => {
  const sid = createDeviceSid();
  assert.match(sid, /^[A-Za-z0-9_-]+$/);
  assert.equal(sid.length, 32);
  assert.notEqual(sid, createDeviceSid());

  const nonce = createNonce();
  assert.match(nonce, /^[A-Za-z0-9_-]+$/);
  assert.ok(nonce.length >= 32);
  assert.notEqual(nonce, createNonce());
});

test("完整配对流程的密钥与证明可端到端复现", () => {
  // 模拟设备侧生成，再模拟终端侧验证
  const password = createPassword();
  const passHash = derivePassHash(password);
  const sid = createDeviceSid();

  const deviceNonce = createNonce();
  const deviceProof = calculateProof(passHash, deviceNonce, "device", sid);
  assert.equal(verifyProof(calculateProof(passHash, deviceNonce, "device", sid), deviceProof), true);

  const terminalNonce = createNonce();
  const terminalProof = calculateProof(passHash, terminalNonce, "terminal", sid);
  assert.equal(
    verifyProof(calculateProof(passHash, terminalNonce, "terminal", sid), terminalProof),
    true,
  );
  // 交叉角色必须失败
  assert.equal(verifyProof(deviceProof, terminalProof), false);
});
