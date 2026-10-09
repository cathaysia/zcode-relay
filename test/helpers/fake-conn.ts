/**
 * 测试用假连接：把 RelayCore 与真实 socket 解耦，使状态机可以单独测试。
 */

import type { Conn } from "../../src/relay/conn.ts";
import type { Outbound } from "../../src/protocol/messages.ts";
import { errorMessage, serializeOutbound } from "../../src/protocol/messages.ts";

let counter = 0;

export class FakeConn implements Conn {
  readonly id: string;
  readonly queryMid: string | undefined = undefined;
  readonly deviceIdHeader: string | undefined = undefined;
  readonly sent: string[] = [];
  closed = false;

  constructor(label = "conn") {
    counter += 1;
    this.id = `${label}-${counter}`;
  }

  /** 与 WsConn 同义：close() 之前一直可写。 */
  get isOpen(): boolean {
    return !this.closed;
  }

  sendRaw(text: string): void {
    this.sent.push(text);
  }

  send(msg: Outbound): void {
    this.sent.push(serializeOutbound(msg));
  }

  sendError(code: Parameters<typeof errorMessage>[0], message?: string): void {
    this.send(errorMessage(code, message));
  }

  close(): void {
    this.closed = true;
  }

  /** 已发送消息（解析后）。 */
  messages(): Record<string, unknown>[] {
    return this.sent.map((s) => JSON.parse(s) as Record<string, unknown>);
  }

  /** 取最后一条已发送消息。 */
  last(): Record<string, unknown> | undefined {
    const all = this.messages();
    return all[all.length - 1];
  }

  /** 清空已发送缓冲，便于对后续行为做断言。 */
  clear(): void {
    this.sent.length = 0;
  }

  /** 取全部已发送消息的 type 序列。 */
  types(): string[] {
    return this.messages().map((m) => String(m["type"]));
  }

  /** 取指定 type 的消息。 */
  ofType(type: string): Record<string, unknown>[] {
    return this.messages().filter((m) => m["type"] === type);
  }
}
