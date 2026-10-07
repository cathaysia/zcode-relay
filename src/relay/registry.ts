/**
 * 会话注册表。见 docs/design.md §3、docs/protocol.md §10.5。
 *
 * pass_hash 只驻内存、不落盘：relay 重启后设备收到 AUTH_FAILED 会自动
 * 清本地凭据并以同一 pass_hash 重新注册，行为自愈，代价仅是旧链接失效。
 */

import type { Conn } from "./conn.ts";
import type { PairStatus } from "../protocol/limits.ts";

export interface Session {
  readonly deviceSid: string;
  /** HMAC 密钥。仅内存。 */
  readonly passHash: string;
  deviceConn: Conn | null;
  terminalConn: Conn | null;
  /** 上次广播过的配对状态，用于抑制 waiting/matched 振荡。 */
  lastStatus: PairStatus | null;
}

export class SessionRegistry {
  readonly #sessions = new Map<string, Session>();

  put(session: Session): void {
    this.#sessions.set(session.deviceSid, session);
  }

  get(deviceSid: string): Session | undefined {
    return this.#sessions.get(deviceSid);
  }

  delete(deviceSid: string): void {
    this.#sessions.delete(deviceSid);
  }

  get size(): number {
    return this.#sessions.size;
  }
}
