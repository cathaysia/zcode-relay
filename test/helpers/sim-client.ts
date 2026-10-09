/**
 * 模拟 device / terminal 客户端，走真实 WebSocket。
 * 行为按 docs/protocol.md §4 的报文与时序实现。
 *
 * 客户端用 `ws`（而不是 Deno 原生 WebSocket）：设备侧必须能发自定义请求头
 * `X-Device-ID`，而 WHATWG WebSocket 的第二个参数是子协议，发不了请求头。
 *
 * 注意 expectType 是**消费式**的：命中的消息不会被后续 expect 再次匹配。
 * 这让"等待下一条同类型消息"的断言能够成立。
 */

import { WebSocket } from "ws";
import type { AuthRole } from "../../src/protocol/limits.ts";
import { calculateProof } from "../../src/protocol/crypto.ts";

interface Frame {
  readonly text: string;
  readonly msg: Record<string, unknown> | null;
}

interface Waiter {
  readonly predicate: (msg: Record<string, unknown>) => boolean;
  readonly label: string;
  readonly resolve: (msg: Record<string, unknown>) => void;
  readonly reject: (err: Error) => void;
  readonly timer: number;
}

const DEFAULT_TIMEOUT_MS = 4_000;
const UTF8_DECODER = new TextDecoder("utf-8");

export class SimClient {
  readonly role: AuthRole;
  readonly #socket: WebSocket;
  readonly #frames: Frame[] = [];
  readonly #consumed = new Set<number>();
  readonly #waiters: Waiter[] = [];
  closed = false;

  private constructor(socket: WebSocket, role: AuthRole) {
    this.#socket = socket;
    this.role = role;
    socket.on("message", (data: unknown) => {
      const text = typeof data === "string"
        ? data
        : data instanceof ArrayBuffer
        ? UTF8_DECODER.decode(new Uint8Array(data))
        : UTF8_DECODER.decode(data as Uint8Array);
      let msg: Record<string, unknown> | null = null;
      try {
        const parsed: unknown = JSON.parse(text);
        if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
          msg = parsed as Record<string, unknown>;
        }
      } catch {
        msg = null;
      }
      this.#frames.push({ text, msg });
      this.#settle();
    });
    socket.on("close", () => {
      this.closed = true;
      for (const w of this.#waiters.splice(0)) {
        clearTimeout(w.timer);
        w.reject(new Error(`socket closed while awaiting ${w.label}`));
      }
    });
  }

  /** 已收到的全部原始文本，顺序与到达顺序一致。 */
  get rawReceived(): string[] {
    return this.#frames.map((f) => f.text);
  }

  /** 已收到的全部可解析消息（不区分是否已被消费）。 */
  get received(): Record<string, unknown>[] {
    return this.#frames.flatMap((f) => (f.msg === null ? [] : [f.msg]));
  }

  #settle(): void {
    let progress = true;
    while (progress && this.#waiters.length > 0) {
      progress = false;
      for (let i = 0; i < this.#frames.length; i += 1) {
        if (this.#consumed.has(i)) continue;
        const frame = this.#frames[i];
        if (frame === undefined || frame.msg === null) continue;
        const w = this.#waiters.findIndex((x) => x.predicate(frame.msg as Record<string, unknown>));
        if (w < 0) continue;
        const waiter = this.#waiters.splice(w, 1)[0];
        if (waiter === undefined) continue;
        this.#consumed.add(i);
        clearTimeout(waiter.timer);
        waiter.resolve(frame.msg);
        progress = true;
        break;
      }
    }
  }

  #expect(
    predicate: (msg: Record<string, unknown>) => boolean,
    label: string,
    timeoutMs = DEFAULT_TIMEOUT_MS,
  ): Promise<Record<string, unknown>> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        const i = this.#waiters.findIndex((w) => w.timer === timer);
        if (i >= 0) this.#waiters.splice(i, 1);
        reject(new Error(`等待 ${label} 超时（${timeoutMs}ms）`));
      }, timeoutMs);
      this.#waiters.push({ predicate, label, resolve, reject, timer });
      this.#settle();
    });
  }

  expectType(type: string, timeoutMs?: number): Promise<Record<string, unknown>> {
    return this.#expect((m) => m["type"] === type, `type=${type}`, timeoutMs);
  }

  expectError(code: string, timeoutMs?: number): Promise<Record<string, unknown>> {
    return this.#expect(
      (m) => m["type"] === "error" && m["code"] === code,
      `error code=${code}`,
      timeoutMs,
    );
  }

  expectPairStatus(status: string, timeoutMs?: number): Promise<Record<string, unknown>> {
    return this.#expect(
      (m) =>
        (m["type"] === "auth_ack" || m["type"] === "pair_status_ack") &&
        m["pair_status"] === status,
      `pair_status=${status}`,
      timeoutMs,
    );
  }

  /** 断言在给定时间内不再收到任何未被消费的消息。 */
  async expectSilence(ms = 250): Promise<void> {
    await new Promise((r) => setTimeout(r, ms));
    const pending = this.#frames.length - this.#consumed.size;
    if (pending > 0) {
      const extra = this.#frames
        .map((f, i) => (this.#consumed.has(i) ? null : f.text))
        .filter((t): t is string => t !== null);
      throw new Error(`预期静默但收到 ${pending} 条消息: ${extra.join(" | ")}`);
    }
  }

  send(obj: unknown): void {
    this.#socket.send(JSON.stringify(obj));
  }

  /** 直接发原始文本，用于验证字节级行为。 */
  sendRaw(text: string): void {
    this.#socket.send(text);
  }

  async replyChallenge(
    passHash: string,
    deviceSid: string,
    role: AuthRole,
    nonce: string,
  ): Promise<void> {
    this.send({
      type: "auth_response",
      device_sid: deviceSid,
      proof: await calculateProof(passHash, nonce, role, deviceSid),
      client_ts: Date.now(),
    });
  }

  clear(): void {
    this.#frames.length = 0;
    this.#consumed.clear();
  }

  async close(): Promise<void> {
    if (this.closed) return;
    await new Promise<void>((resolve) => {
      this.#socket.once("close", () => resolve());
      this.#socket.close();
    });
  }

  /** 立即断开（模拟网络掉线，而非正常关闭）。 */
  terminate(): void {
    this.#socket.terminate();
  }

  static async open(
    url: string,
    role: AuthRole,
    headers?: Record<string, string>,
  ): Promise<SimClient> {
    const socket = new WebSocket(url, headers === undefined ? {} : { headers });
    await new Promise<void>((resolve, reject) => {
      socket.once("open", resolve);
      socket.once("error", reject);
    });
    return new SimClient(socket, role);
  }
}

export interface DeviceHandle {
  readonly client: SimClient;
  readonly deviceSid: string;
}

const META_DEVICE = { platform: "linux", version: "test", name: "desktop-sim" };

/** 首次注册（register 模式），走完设备侧完整握手。 */
export async function registerDevice(
  url: string,
  passHash: string,
  mid: string,
): Promise<DeviceHandle> {
  const client = await SimClient.open(`${url}?mid=${encodeURIComponent(mid)}`, "device", {
    "X-Device-ID": mid,
  });
  client.send({
    type: "device_register_init",
    device_mid: mid,
    pass_hash: passHash,
    meta: META_DEVICE,
    client_ts: Date.now(),
  });
  const ack = await client.expectType("device_register_ack");
  const deviceSid = String(ack["device_sid"]);

  client.send({
    type: "auth_init",
    role: "device",
    device_sid: deviceSid,
    meta: META_DEVICE,
    client_ts: Date.now(),
  });
  const challenge = await client.expectType("auth_challenge");
  await client.replyChallenge(passHash, deviceSid, "device", String(challenge["nonce"]));
  return { client, deviceSid };
}

/** 已注册设备的重连（persisted 模式，不再发 pass_hash）。 */
export async function reconnectDevice(
  url: string,
  passHash: string,
  deviceSid: string,
  mid: string,
): Promise<SimClient> {
  const client = await SimClient.open(`${url}?mid=${encodeURIComponent(mid)}`, "device", {
    "X-Device-ID": mid,
  });
  client.send({
    type: "auth_init",
    role: "device",
    device_sid: deviceSid,
    meta: META_DEVICE,
    client_ts: Date.now(),
  });
  const challenge = await client.expectType("auth_challenge");
  await client.replyChallenge(passHash, deviceSid, "device", String(challenge["nonce"]));
  return client;
}

/** 终端接入。 */
export async function connectTerminal(
  url: string,
  passHash: string,
  deviceSid: string,
): Promise<SimClient> {
  const client = await SimClient.open(`${url}?mid=${encodeURIComponent(deviceSid)}`, "terminal");
  client.send({
    type: "auth_init",
    role: "terminal",
    device_sid: deviceSid,
    meta: { platform: "web", version: "test", name: "mobile-browser" },
    client_ts: Date.now(),
  });
  const challenge = await client.expectType("auth_challenge");
  await client.replyChallenge(passHash, deviceSid, "terminal", String(challenge["nonce"]));
  return client;
}
