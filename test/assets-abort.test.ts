/**
 * 回归测试：客户端读到一半就断开时，服务端必须释放那个文件句柄。
 *
 * 背景：最初用 `createReadStream(...).pipe(res)`，客户端断开时 pipe 只会
 * unpipe 并暂停源流，不 destroy，也不触发 autoClose，于是每个中断请求
 * 永久泄漏一个文件 fd。实测 20 次中断泄漏 20 个，约两百次后 EMFILE。
 * 换成核心原语 `stream.pipeline` 后泄漏为 0。
 *
 * 迁移到 Fastify 后这条不变式换了承载者：`reply.send(stream)` 在响应结束或
 * 出错时销毁源流，客户端中断也走这条路。测试因此原样保留——它守的是不变式，
 * 不是某段实现。
 *
 * 为什么这条路径值得单独一个文件：被服务的是磁盘上的静态 chunk（约 2500 个），
 * 手机上加载到一半切走、下拉刷新、被后续导航取代都会走到这里；
 * 而外壳与入口是内存缓冲、不开 fd，不受影响。
 */

import { assert, assertEquals } from "@std/assert";
import * as posix from "@std/path/posix";
import type { FastifyInstance } from "fastify";

import { AssetProvider } from "../src/assets/provider.ts";
import { buildAssetApp, makeFixtureRoot, RELAY_URL } from "./helpers/asset-app.ts";
import { countRegularFds } from "./helpers/open-fds.ts";

/** 必须够大，否则在 loopback 上会在断开之前就写完，测不到中断。 */
const BIG_NAME = "big-AAA111.js";
const BIG_BYTES = 8 * 1024 * 1024;
const ABORTS = 12;

const delay = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** 读到第一段数据后立刻断开，模拟加载中途切走。 */
async function abortMidTransfer(port: number): Promise<void> {
  let conn: Deno.TcpConn | null = null;
  try {
    conn = await Deno.connect({ hostname: "127.0.0.1", port });
    await conn.write(
      new TextEncoder().encode(
        `GET /remote/v4/latest/assets/${BIG_NAME} HTTP/1.1\r\nHost: assets.test\r\n\r\n`,
      ),
    );
    await conn.read(new Uint8Array(1024));
  } catch {
    // 连接被对端收掉是预期内的
  } finally {
    try {
      conn?.close();
    } catch {
      // 已经断了
    }
  }
}

/**
 * lsof 不可用时整条用例标为 ignored（而不是"跑完算通过"）：量不到的东西
 * 不能声称验过。Deno 2.2 的 `ignore` 只接受布尔值，所以原因单独打出来。
 */
const LSOF_AVAILABLE = countRegularFds() !== null;
if (!LSOF_AVAILABLE) {
  console.warn(
    "lsof 不可用（或未给 --allow-run）：跳过 fd 泄漏回归测试，这条不变式本次未被验证",
  );
}

Deno.test({
  name: "客户端中途断开不泄漏文件描述符",
  ignore: !LSOF_AVAILABLE,
  // 两个 sanitizer 都关掉：客户端中断的连接在 Deno 的 HTTP 服务器里会留一个
  // 约 1 秒的关停宽限 timer（实测：等 100 ms 它还在，等 1100 ms 才消失），
  // 而 op/resource 泄漏检查按用例归属这种定时器，于是它必然被判成跨用例泄漏。
  // 那是平台内部行为，不是本仓库创建的资源。
  //
  // 关掉检查并不降低这条用例的强度：它真正要守的是"中断的传输不留文件
  // 描述符"，而那是由 lsof 直接数进程的 REG fd 得到的——比 Deno 的
  // resource 检查更强（后者看不到 node:fs 流持有的 fd）。
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    const root = await makeFixtureRoot();
    await Deno.writeFile(posix.join(root, "assets", BIG_NAME), new Uint8Array(BIG_BYTES).fill(65));

    const provider = new AssetProvider({ rootDir: root, relayUrl: RELAY_URL });
    let app: FastifyInstance | null = null;
    try {
      await provider.prepare();
      app = buildAssetApp(provider);
      await app.listen({ host: "127.0.0.1", port: 0 });
      const bound = app.server.address();
      assert(bound !== null && typeof bound !== "string", "app 必须有 TCP 地址");
      const port = bound.port;

      // 基线取在服务已就绪之后：这样只有"中断的传输"能解释后续的增长
      const before = countRegularFds();
      assert(before !== null);

      for (let i = 0; i < ABORTS; i += 1) await abortMidTransfer(port);
      await delay(500);

      let growth = (countRegularFds() ?? before) - before;
      if (growth > 0) {
        // 拆除是异步的，给一次余量再判，避免把慢一拍误报成泄漏
        await delay(1000);
        growth = (countRegularFds() ?? before) - before;
      }
      assertEquals(
        growth,
        0,
        `${String(ABORTS)} 次中断后普通文件描述符增长了 ${String(growth)} 个，说明源流没被销毁`,
      );

      // 确认服务仍然可用，排除"靠出错而没泄漏"这种假通过
      const res = await app.inject({ url: `/remote/v4/latest/assets/${BIG_NAME}` });
      assertEquals(res.statusCode, 200);
      assertEquals(res.rawPayload.byteLength, BIG_BYTES);
    } finally {
      if (app !== null) await app.close();
      await Deno.remove(root, { recursive: true });
    }
  },
});
