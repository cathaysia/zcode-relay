/**
 * 回归测试：客户端读到一半就断开时，服务端必须释放那个文件句柄。
 *
 * 背景：原先用 `createReadStream(...).pipe(res)`，客户端断开时 pipe 只会
 * unpipe 并暂停源流，不 destroy，也不触发 autoClose，于是每个中断请求
 * 永久泄漏一个文件 fd。实测 20 次中断泄漏 20 个，约两百次后 EMFILE。
 * 换成核心原语 `stream.pipeline` 后泄漏为 0。
 *
 * 为什么这条路径值得单独一个文件：被服务的是磁盘上的静态 chunk（约 2500 个），
 * 手机上加载到一半切走、下拉刷新、被后续导航取代都会走到这里；
 * 而外壳与入口是内存缓冲、不开 fd，不受影响。
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import net, { type AddressInfo } from "node:net";

import { AssetServer } from "../src/assets/server.ts";
import { countRegularFds } from "./helpers/open-fds.ts";

/** 必须够大，否则在 loopback 上会在断开之前就写完，测不到中断。 */
const BIG_NAME = "big-AAA111.js";
const BIG_BYTES = 8 * 1024 * 1024;
const ABORTS = 12;

const delay = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** 读到第一段数据后立刻断开，模拟加载中途切走。 */
function abortMidTransfer(port: number): Promise<void> {
  return new Promise((resolve) => {
    const socket = net.connect(port, "127.0.0.1", () => {
      socket.write(
        `GET /remote/v4/latest/assets/${BIG_NAME} HTTP/1.1\r\nHost: assets.test\r\n\r\n`,
      );
    });
    let started = false;
    socket.on("data", () => {
      if (started) return;
      started = true;
      socket.destroy();
      resolve();
    });
    socket.on("error", () => resolve());
    socket.on("close", () => resolve());
  });
}

test("客户端中途断开不泄漏文件描述符", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "zcabort-"));
  const assets = new AssetServer({ rootDir: root, relayUrl: "wss://relay.test/ws" });
  let server: ReturnType<typeof createServer> | null = null;

  try {
    await mkdir(join(root, "assets"), { recursive: true });
    await writeFile(join(root, "index.html"), "<html><head></head></html>", "utf8");
    await writeFile(join(root, "assets", BIG_NAME), Buffer.alloc(BIG_BYTES, 65));

    await assets.prepare();
    const started = createServer(assets.handler());
    server = started;
    await new Promise<void>((resolve) => started.listen(0, "127.0.0.1", resolve));
    const port = (started.address() as AddressInfo).port;

    const before = countRegularFds();
    if (before === null) {
      t.skip("lsof 不可用，无法测量文件描述符");
      return;
    }

    for (let i = 0; i < ABORTS; i += 1) await abortMidTransfer(port);
    await delay(500);

    let growth = (countRegularFds() ?? before) - before;
    if (growth > 0) {
      // 拆除是异步的，给一次余量再判，避免把慢一拍误报成泄漏
      await delay(1000);
      growth = (countRegularFds() ?? before) - before;
    }
    assert.equal(
      growth,
      0,
      `${String(ABORTS)} 次中断后普通文件描述符增长了 ${String(growth)} 个，说明源流没被销毁`,
    );

    // 确认服务仍然可用，排除"靠出错而没泄漏"这种假通过
    const res = await fetch(`http://127.0.0.1:${String(port)}/remote/v4/latest/assets/${BIG_NAME}`);
    assert.equal(res.status, 200);
    assert.equal((await res.arrayBuffer()).byteLength, BIG_BYTES);
  } finally {
    const closing = server;
    if (closing !== null) {
      await new Promise<void>((resolve) => closing.close(() => resolve()));
    }
    await rm(root, { recursive: true, force: true });
  }
});
