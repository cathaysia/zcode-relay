import { assert, assertEquals, assertMatch, assertNotEquals } from "@std/assert";
import { encodeBase64 } from "@std/encoding/base64";
import { encodeBase64Url } from "@std/encoding/base64url";

import {
  calculateProof,
  createDeviceSid,
  createNonce,
  createPassword,
  derivePassHash,
  verifyProof,
} from "../src/protocol/crypto.ts";

const UTF8 = new TextEncoder();

Deno.test("createPassword 产出 32 字符的 base64url", () => {
  const pw = createPassword();
  assertEquals(pw.length, 32);
  assertMatch(pw, /^[A-Za-z0-9_-]+$/);
  // 24 字节随机 → 每次不同
  assertNotEquals(pw, createPassword());
});

Deno.test("derivePassHash 是标准 base64 且带 '=' 填充", async () => {
  const hash = await derivePassHash("some-password");
  // sha256 = 32 字节 → base64 44 字符，末尾一个 '='
  assertEquals(hash.length, 44);
  assert(hash.endsWith("="), `expected '=' padding, got ${hash}`);
  assertMatch(hash, /^[A-Za-z0-9+/]+={0,2}$/);
  // 与直接计算一致
  assertEquals(hash, await derivePassHash("some-password"));
});

Deno.test("derivePassHash 与手工 SHA-256 计算一致", async () => {
  const digest = await crypto.subtle.digest("SHA-256", UTF8.encode("the-password"));
  assertEquals(await derivePassHash("the-password"), encodeBase64(new Uint8Array(digest)));
});

Deno.test("calculateProof 是 base64url 且无填充", async () => {
  const proof = await calculateProof("hash", "nonce", "device", "sid");
  assert(!proof.includes("="), `proof 不应含填充: ${proof}`);
  assert(!proof.includes("+"), `proof 不应含 '+': ${proof}`);
  assert(!proof.includes("/"), `proof 不应含 '/': ${proof}`);
  assertMatch(proof, /^[A-Za-z0-9_-]+$/);
});

Deno.test("calculateProof 与 role 绑定", async () => {
  const asDevice = await calculateProof("hash", "nonce", "device", "sid");
  const asTerminal = await calculateProof("hash", "nonce", "terminal", "sid");
  assertNotEquals(asDevice, asTerminal, "role 必须参与证明计算");
});

Deno.test("calculateProof 与 nonce、device_sid 和 pass_hash 绑定", async () => {
  const base = await calculateProof("h", "n1", "device", "s1");
  assertNotEquals(base, await calculateProof("h", "n2", "device", "s1"));
  assertNotEquals(base, await calculateProof("h", "n1", "device", "s2"));
  assertNotEquals(base, await calculateProof("h2", "n1", "device", "s1"));
});

Deno.test("calculateProof 与手工 HMAC 计算一致（terminal 侧就是这么算的）", async () => {
  const key = await crypto.subtle.importKey(
    "raw",
    UTF8.encode("the-hash"),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = await crypto.subtle.sign("HMAC", key, UTF8.encode("the-nonce|device|the-sid"));
  assertEquals(
    await calculateProof("the-hash", "the-nonce", "device", "the-sid"),
    encodeBase64Url(new Uint8Array(signature)),
  );
});

Deno.test("verifyProof 接受正确 proof，拒绝一切变形", async () => {
  const passHash = await derivePassHash("h");
  const proof = await calculateProof(passHash, "n", "device", "s");
  assertEquals(await verifyProof(passHash, "n", "device", "s", proof), true);

  assertEquals(
    await verifyProof(passHash, "n", "device", "s", `${proof}x`),
    false,
    "长度不同应为 false",
  );
  assertEquals(await verifyProof(passHash, "n", "device", "s", "short"), false);
  assertEquals(
    await verifyProof(passHash, "n", "device", "s", proof.slice(0, -1) + "A"),
    false,
    "改动末位应为 false",
  );
  assertEquals(await verifyProof(passHash, "other-nonce", "device", "s", proof), false);
  assertEquals(await verifyProof(passHash, "n", "terminal", "s", proof), false, "角色不匹配");
  assertEquals(await verifyProof(passHash, "n", "device", "other-sid", proof), false);
  assertEquals(await verifyProof(await derivePassHash("other"), "n", "device", "s", proof), false);
});

Deno.test("verifyProof 对非法 base64url 返回 false 而不抛错", async () => {
  const passHash = await derivePassHash("h");
  for (const bad of ["!!!not-base64!!!", "with space", "中文", ""]) {
    assertEquals(
      await verifyProof(passHash, "n", "device", "s", bad),
      false,
      `非法 proof 应判 false: ${JSON.stringify(bad)}`,
    );
  }
});

Deno.test("createDeviceSid 与 createNonce 是 URL 安全的唯一值", () => {
  const sid = createDeviceSid();
  assertMatch(sid, /^[A-Za-z0-9_-]+$/);
  assertEquals(sid.length, 32);
  assertNotEquals(sid, createDeviceSid());

  const nonce = createNonce();
  assertMatch(nonce, /^[A-Za-z0-9_-]+$/);
  assert(nonce.length >= 32);
  assertNotEquals(nonce, createNonce());
});

Deno.test("完整配对流程的密钥与证明可端到端复现", async () => {
  // 模拟设备侧生成，再模拟终端侧验证
  const password = createPassword();
  const passHash = await derivePassHash(password);
  const sid = createDeviceSid();

  const deviceNonce = createNonce();
  const deviceProof = await calculateProof(passHash, deviceNonce, "device", sid);
  assertEquals(await verifyProof(passHash, deviceNonce, "device", sid, deviceProof), true);

  const terminalNonce = createNonce();
  const terminalProof = await calculateProof(passHash, terminalNonce, "terminal", sid);
  assertEquals(await verifyProof(passHash, terminalNonce, "terminal", sid, terminalProof), true);

  // 交叉角色必须失败：把 device 的 proof 拿去当 terminal 的应答
  assertEquals(await verifyProof(passHash, terminalNonce, "terminal", sid, deviceProof), false);
  assertEquals(await verifyProof(passHash, deviceNonce, "device", sid, terminalProof), false);
});
