/**
 * Relay 核心。承载四个职责：认证、配对状态、定向转发、心跳应答。
 * 逐条对应 docs/protocol.md §10 的必需行为。
 *
 * 三条容易做错的地方，实现里都显式处理了：
 *
 * 1. 设备侧的 wasPaired 不会被普通断线重连重置，所以设备一旦重连并认证
 *    成功，relay **必须**立即把当前状态（通常是 matched）发给它，否则设备
 *    会把收到的 waiting 判为陈旧并自行重连。
 *
 * 2. 反过来，配对状态不能振荡——设备每次收到 waiting 都是有破坏性的
 *    （第一次触发 15 秒恢复窗口，第二次直接重连）。因此除认证后的强制发送
 *    之外，状态只在**真正变化**时推送。
 *
 * 3. 认证校验是异步的（Web Crypto 无同步 HMAC，见 protocol/crypto.ts）。
 *    因此认证路径按连接串行化，且校验返回后要重新确认连接还活着——否则
 *    "校验期间对端断开"会留下一条指向死 socket 的会话。data 转发不进队列，
 *    逐帧零额外开销。
 */

import type { Conn } from "./conn.ts";
import { type Session, SessionRegistry } from "./registry.ts";
import type { AuthRole, PairStatus } from "../protocol/limits.ts";
import { createDeviceSid, createNonce, verifyProof } from "../protocol/crypto.ts";
import { type Inbound, parseInbound } from "../protocol/messages.ts";

export interface Logger {
  info(message: string, fields?: Record<string, unknown>): void;
  warn(message: string, fields?: Record<string, unknown>): void;
}

const NOOP_LOGGER: Logger = { info: () => {}, warn: () => {} };

interface Pending {
  readonly session: Session;
  readonly role: AuthRole;
  readonly nonce: string;
}

interface Attachment {
  readonly session: Session;
  readonly role: AuthRole;
}

export class RelayCore {
  readonly #registry = new SessionRegistry();
  readonly #attached = new Map<Conn, Attachment>();
  readonly #pending = new Map<Conn, Pending>();
  readonly #authQueue = new Map<Conn, Promise<void>>();
  readonly #log: Logger;

  constructor(log: Logger = NOOP_LOGGER) {
    this.#log = log;
  }

  get sessionCount(): number {
    return this.#registry.size;
  }

  /** 新连接建立。无需动作：设备会发 device_register_init，终端会发 auth_init。 */
  handleConnect(conn: Conn): void {
    this.#log.info("connect", { conn: conn.id, mid: conn.queryMid });
  }

  /**
   * 处理一条入站报文。返回值在"这条报文引发的处理"结束时 resolve。
   *
   * data 转发是同步完成的：async 函数体在第一个 await 之前同步执行，而
   * #onData 里没有任何 await，故逐帧保序不受影响。
   */
  async handleMessage(conn: Conn, raw: string, frameBytes?: number): Promise<void> {
    const msg = parseInbound(raw, frameBytes);
    if (msg === null) {
      // 格式非法或超限：丢弃该消息，不断连
      this.#log.warn("drop malformed message", { conn: conn.id, bytes: raw.length });
      return;
    }
    switch (msg.type) {
      case "device_register_init":
        this.#onRegister(conn, msg);
        return;
      case "auth_init":
        this.#onAuthInit(conn, msg);
        return;
      case "auth_response":
        await this.#serializeAuth(conn, () => this.#onAuthResponse(conn, msg));
        return;
      case "pair_status_query":
        this.#onHeartbeat(conn, msg);
        return;
      case "data":
        this.#onData(conn, msg);
        return;
    }
  }

  handleClose(conn: Conn): void {
    this.#pending.delete(conn);
    this.#authQueue.delete(conn);
    const att = this.#attached.get(conn);
    if (att === undefined) {
      this.#log.info("close (unauthenticated)", { conn: conn.id });
      return;
    }
    this.#attached.delete(conn);
    const { session, role } = att;
    if (session.deviceConn === conn) session.deviceConn = null;
    if (session.terminalConn === conn) session.terminalConn = null;

    this.#log.info("close", { conn: conn.id, role, sid: session.deviceSid });

    if (role === "device" && session.terminalConn !== null) {
      // 会话保留，等设备重连；终端有 15 秒宽限期
      session.terminalConn.sendError("DEVICE_OFFLINE", "desktop disconnected");
    }
    this.#pushStatusIfChanged(session);
  }

  // ---- 注册与认证 ----

  #onRegister(conn: Conn, msg: Extract<Inbound, { type: "device_register_init" }>): void {
    const deviceSid = createDeviceSid();
    const session: Session = {
      deviceSid,
      passHash: msg.passHash,
      deviceConn: null,
      terminalConn: null,
      lastStatus: null,
    };
    this.#registry.put(session);
    conn.send({ type: "device_register_ack", device_sid: deviceSid });
    this.#log.info("device registered", {
      conn: conn.id,
      sid: deviceSid,
      mid: msg.deviceMid,
      platform: msg.meta.platform,
      version: msg.meta.version,
    });
  }

  #onAuthInit(conn: Conn, msg: Extract<Inbound, { type: "auth_init" }>): void {
    const session = this.#registry.get(msg.deviceSid);
    if (session === undefined) {
      conn.sendError("AUTH_FAILED", "unknown device_sid");
      this.#log.warn("auth_init for unknown sid", { conn: conn.id, sid: msg.deviceSid });
      return;
    }
    const nonce = createNonce();
    this.#pending.set(conn, { session, role: msg.role, nonce });
    conn.send({ type: "auth_challenge", nonce });
    this.#log.info("challenge issued", { conn: conn.id, role: msg.role, sid: session.deviceSid });
  }

  async #onAuthResponse(
    conn: Conn,
    msg: Extract<Inbound, { type: "auth_response" }>,
  ): Promise<void> {
    const pending = this.#pending.get(conn);
    if (pending === undefined) {
      conn.sendError("AUTH_FAILED", "no pending challenge");
      return;
    }
    // 先同步消费掉挑战，再 await：异步窗口期内的第二条应答不应再匹配到它。
    this.#pending.delete(conn);

    if (pending.session.deviceSid !== msg.deviceSid) {
      conn.sendError("AUTH_FAILED", "device_sid mismatch");
      return;
    }

    // proof 与 role 字符串绑定，角色弄错必然不匹配
    const ok = await verifyProof(
      pending.session.passHash,
      pending.nonce,
      pending.role,
      pending.session.deviceSid,
      msg.proof,
    );
    if (!ok) {
      conn.sendError("AUTH_FAILED", "proof mismatch");
      this.#log.warn("auth failed", {
        conn: conn.id,
        role: pending.role,
        sid: pending.session.deviceSid,
      });
      return;
    }

    // 校验期间对端可能已断开：附着一条死连接会让会话永远显示 matched。
    if (!conn.isOpen) {
      this.#log.warn("connection closed during auth verification", { conn: conn.id });
      return;
    }

    this.#attach(conn, pending.session, pending.role);
    this.#log.info("authenticated", {
      conn: conn.id,
      role: pending.role,
      sid: pending.session.deviceSid,
    });
    this.#sendStatusOnAuth(conn, pending.session, pending.role);
  }

  /**
   * 认证路径按连接串行化。异步校验若不串行，同一连接上的两条 auth_response
   * 会交叠：后到的那条会在第一条附着之前被判成"无待验证挑战"，于是
   * AUTH_FAILED 会插到 auth_ack 前面到达——而 AUTH_FAILED 在客户端是致命的。
   * 串行化后处理顺序恒等于到达顺序，与同步实现一致。
   */
  #serializeAuth(conn: Conn, task: () => Promise<void>): Promise<void> {
    const previous = this.#authQueue.get(conn) ?? Promise.resolve();
    const chained = previous.then(task, task).catch((err: unknown) => {
      this.#log.warn("auth handler failed", {
        conn: conn.id,
        error: err instanceof Error ? err.message : String(err),
      });
    });
    const settled = chained.finally(() => {
      if (this.#authQueue.get(conn) === settled) this.#authQueue.delete(conn);
    });
    this.#authQueue.set(conn, settled);
    return settled;
  }

  // ---- 附着与配对状态 ----

  #attach(conn: Conn, session: Session, role: AuthRole): void {
    const previous = this.#attached.get(conn);
    if (previous !== undefined && previous.session !== session) {
      this.#detachFromSession(conn, previous);
    }

    if (role === "device") {
      const old = session.deviceConn;
      if (old !== null && old !== conn) {
        // 同会话的设备对设备冲突规则协议未定义：后到者胜，关掉旧连接。
        // 被关掉的设备会立刻重连，因此这不是驱逐设备的手段。
        this.#log.warn("device superseded", { sid: session.deviceSid, old: old.id });
        old.close();
      }
      session.deviceConn = conn;
    } else {
      const old = session.terminalConn;
      if (old !== null && old !== conn) {
        // 单终端策略：向旧终端发 KICKED，它会进入终态且不再重连
        this.#log.info("terminal kicked", { sid: session.deviceSid, old: old.id });
        old.sendError("KICKED", "another remote control device has connected");
        old.close();
      }
      session.terminalConn = conn;
    }
    this.#attached.set(conn, { session, role });
  }

  #detachFromSession(conn: Conn, att: Attachment): void {
    if (att.session.deviceConn === conn) att.session.deviceConn = null;
    if (att.session.terminalConn === conn) att.session.terminalConn = null;
  }

  #statusOf(session: Session): PairStatus {
    return session.deviceConn !== null && session.terminalConn !== null ? "matched" : "waiting";
  }

  /**
   * 认证成功后的状态发送。认证方**总是**收到（设备重连后靠这个清掉陈旧判定）；
   * 对端只在状态真正变化时收到，以免触发多余的重放。
   */
  #sendStatusOnAuth(conn: Conn, session: Session, role: AuthRole): void {
    const status = this.#statusOf(session);
    const changed = session.lastStatus !== status;
    session.lastStatus = status;

    conn.send({ type: "auth_ack", pair_status: status });

    const peer = role === "device" ? session.terminalConn : session.deviceConn;
    if (changed && peer !== null) {
      peer.send({ type: "pair_status_ack", pair_status: status });
    }
  }

  /** 连接增减后的状态推送：仅在状态变化时发，避免 waiting/matched 振荡。 */
  #pushStatusIfChanged(session: Session): void {
    const status = this.#statusOf(session);
    if (session.lastStatus === status) return;
    session.lastStatus = status;
    session.deviceConn?.send({ type: "pair_status_ack", pair_status: status });
    session.terminalConn?.send({ type: "pair_status_ack", pair_status: status });
  }

  // ---- 心跳与转发 ----

  #onHeartbeat(conn: Conn, msg: Extract<Inbound, { type: "pair_status_query" }>): void {
    const att = this.#attached.get(conn);
    if (att === undefined || att.session.deviceSid !== msg.deviceSid) {
      // 未认证连接或 sid 不符：忽略而不发 error。
      // 对未配对客户端而言未知 error 是致命的，静默丢弃更安全。
      this.#log.warn("ignore stray heartbeat", { conn: conn.id, sid: msg.deviceSid });
      return;
    }
    conn.send({ type: "pair_status_ack", pair_status: this.#statusOf(att.session) });
  }

  #onData(conn: Conn, msg: Extract<Inbound, { type: "data" }>): void {
    const att = this.#attached.get(conn);
    if (att === undefined) {
      this.#log.warn("drop data from unauthenticated conn", { conn: conn.id });
      return;
    }
    const { session, role } = att;
    if (this.#statusOf(session) !== "matched") {
      // 未配对不转发。设备侧在非 paired 状态本就会静默丢弃入站 data。
      return;
    }
    const peer = role === "device" ? session.terminalConn : session.deviceConn;
    if (peer === null) return;
    // 逐字节转发：不解析、不重排、不改写 payload
    peer.sendRaw(msg.raw);
  }
}
