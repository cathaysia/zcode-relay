/**
 * SPA 资源抓取。流程见 docs/patching.md §4。
 *
 * 用法：
 *   deno task fetch-assets <outDir> [--limit N] [--delay ms] [--dry-run]
 *
 * 默认并发 8、不限速。完整抓取约 2000+ 个文件（其中约 370 个是
 * 不在 __vite__mapDeps 里的动态 import 目标），因此先用 --limit 小批量验证
 * 再全量抓取。
 *
 * 抓下来的是厂商著作权代码，**.gitignore 已排除，不要提交**。
 *
 * 本工具**不改写任何文件**：抓下来的树是厂商资源的忠实镜像，manifest.json
 * 里的 sha256 始终可校验。relay patch 在启动服务时套用（内存 overlay），
 * 见 src/serve/main.ts。
 */

import * as posix from "@std/path/posix";

import { ASSET_URL_PREFIX, type AssetKind, extractRefs, kindOf } from "./asset-graph.ts";
import { inspectAnchors } from "./patch-spa.ts";
import { sha256Hex } from "./digest.ts";
import { utf8ByteLength } from "../protocol/messages.ts";

const DEFAULT_ORIGIN = "https://zcode.z.ai";
const DEFAULT_DELAY_MS = 0;
const DEFAULT_CONCURRENCY = 8;

const UTF8 = new TextEncoder();
const UTF8_DECODER = new TextDecoder("utf-8");

interface Options {
  readonly outDir: string;
  readonly origin: string;
  readonly limit: number;
  readonly delayMs: number;
  readonly concurrency: number;
  readonly dryRun: boolean;
}

function parseArgs(argv: string[]): Options | null {
  const positional: string[] = [];
  let origin = DEFAULT_ORIGIN;
  let limit = Number.POSITIVE_INFINITY;
  let delayMs = DEFAULT_DELAY_MS;
  let concurrency = DEFAULT_CONCURRENCY;
  let dryRun = false;

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--dry-run") {
      dryRun = true;
    } else if (arg === "--limit") {
      const value = argv[i + 1];
      if (value === undefined) return null;
      limit = Number(value);
      i += 1;
    } else if (arg === "--delay") {
      const value = argv[i + 1];
      if (value === undefined) return null;
      delayMs = Number(value);
      i += 1;
    } else if (arg === "--concurrency" || arg === "-c") {
      const value = argv[i + 1];
      if (value === undefined) return null;
      concurrency = Number(value);
      i += 1;
    } else if (arg === "--base") {
      const value = argv[i + 1];
      if (value === undefined) return null;
      origin = value.replace(/\/$/, "");
      i += 1;
    } else if (arg !== undefined && !arg.startsWith("--")) {
      positional.push(arg);
    } else {
      return null;
    }
  }

  const outDir = positional[0];
  if (outDir === undefined) return null;
  if (!Number.isFinite(delayMs) || delayMs < 0) return null;
  if (!Number.isInteger(concurrency) || concurrency <= 0) return null;
  return { outDir, origin, limit, delayMs, concurrency, dryRun };
}

function usage(): void {
  console.error(
    "用法: fetch-assets.ts <outDir> [--limit N] [--delay ms] [-c/--concurrency N] [--dry-run] [--base <origin>]",
  );
  console.error("");
  console.error("  --limit N         最多新抓 N 个文件（先用小值验证）");
  console.error("  --delay ms        每次请求间隔，默认 0");
  console.error("  -c, --concurrency 并发抓取数，默认 8");
  console.error("  --dry-run         只算依赖图，不写盘");
  console.error("  --base URL        资源站源，默认 https://zcode.z.ai");
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

async function exists(path: string): Promise<boolean> {
  try {
    await Deno.stat(path);
    return true;
  } catch {
    return false;
  }
}

interface Fetched {
  readonly name: string;
  readonly bytes: number;
  readonly sha256: string;
}

async function main(): Promise<number> {
  const options = parseArgs(Deno.args);
  if (options === null) {
    usage();
    return 2;
  }
  const { outDir, origin, limit, delayMs, concurrency, dryRun } = options;

  const assetsDir = posix.join(outDir, "assets");
  await Deno.mkdir(assetsDir, { recursive: true });

  console.log(`源站      ${origin}`);
  console.log(`输出      ${outDir}`);
  console.log(`并发      ${String(concurrency)} 线程`);
  console.log(`限速      ${String(delayMs)}ms/请求`);
  console.log(`上限      ${Number.isFinite(limit) ? String(limit) : "不限"}`);
  if (dryRun) console.log("模式      仅计算依赖图（不写盘）");
  console.log("");

  // ---- 1. 外壳 ----
  const shellUrl = `${origin}${ASSET_URL_PREFIX.replace(/assets\/$/, "")}`;
  console.log(`[shell] GET ${shellUrl}`);
  const shellResponse = await fetch(shellUrl);
  if (!shellResponse.ok) {
    console.error(`外壳获取失败: HTTP ${String(shellResponse.status)}`);
    return 1;
  }
  const shellHtml = await shellResponse.text();
  if (!dryRun) await Deno.writeTextFile(posix.join(outDir, "index.html"), shellHtml);
  console.log(`[shell] 已保存 index.html（${String(utf8ByteLength(shellHtml))} 字节）`);

  // ---- 2. 依赖图（并发工作池） ----
  const fetched: Fetched[] = [];
  const missing: string[] = [];
  const queue: string[] = [];
  const seen = new Set<string>();

  for (const ref of extractRefs(shellHtml, "html")) {
    queue.push(ref);
    seen.add(ref);
  }
  console.log(`[graph] 外壳引用 ${String(queue.length)} 个资源`);

  let requests = 0;
  let activeWorkers = 0;
  let limitReached = false;

  type Resolver = () => void;
  let waiter: Resolver | null = null;

  const enqueue = (newRefs: Iterable<string>): void => {
    for (const ref of newRefs) {
      if (!seen.has(ref)) {
        seen.add(ref);
        queue.push(ref);
      }
    }
    if (waiter !== null && queue.length > 0) {
      const wake = waiter;
      waiter = null;
      wake();
    }
  };

  const worker = async (workerId: number): Promise<void> => {
    while (!limitReached) {
      if (queue.length === 0) {
        if (activeWorkers === 0) {
          // 所有 worker 都处于空闲状态且队列为空，抓取彻底完成
          if (waiter !== null) {
            const wake = waiter;
            waiter = null;
            wake();
          }
          break;
        }
        // 还有其他 worker 在运行，可能有新引用产出，等待唤醒
        await new Promise<void>((resolve) => {
          waiter = resolve;
        });
        continue;
      }

      const name = queue.shift();
      if (name === undefined) continue;

      const targetPath = posix.join(assetsDir, name);
      const kind: AssetKind = kindOf(name);

      let content: string | null = null;
      let bytes = 0;
      let hash = "";

      if (!dryRun && (await exists(targetPath))) {
        const buf = await Deno.readFile(targetPath);
        content = UTF8_DECODER.decode(buf);
        bytes = buf.byteLength;
        hash = await sha256Hex(buf);
        console.log(
          `[skip] (${String(fetched.length + 1)}) [W${workerId}] ${name} [已存在, ${
            String(bytes)
          }B, 队列:${String(queue.length)}]`,
        );
      } else if (!dryRun && requests >= limit) {
        limitReached = true;
        queue.unshift(name);
        if (waiter !== null) {
          const wake = waiter;
          waiter = null;
          wake();
        }
        break;
      } else {
        const url = `${origin}${ASSET_URL_PREFIX}${name}`;
        requests += 1;
        activeWorkers += 1;
        if (delayMs > 0) await sleep(delayMs);
        try {
          const response = await fetch(url);
          if (!response.ok) {
            missing.push(name);
            console.log(
              `[miss] (${String(fetched.length + 1)}) [W${workerId}] ${name} HTTP ${
                String(response.status)
              }`,
            );
            activeWorkers -= 1;
            continue;
          }
          const type = response.headers.get("content-type") ?? "";
          if (kind !== "html" && type.startsWith("text/html")) {
            missing.push(name);
            console.log(
              `[miss] (${
                String(fetched.length + 1)
              }) [W${workerId}] ${name} 返回外壳（SPA fallback）`,
            );
            activeWorkers -= 1;
            continue;
          }
          const buf = new Uint8Array(await response.arrayBuffer());
          content = UTF8_DECODER.decode(buf);
          bytes = buf.byteLength;
          hash = await sha256Hex(buf);
          if (!dryRun) await Deno.writeFile(targetPath, buf);
          console.log(
            `[get ] (${String(fetched.length + 1)}) [W${workerId}] ${name} [${
              String(bytes)
            }B, 队列:${String(queue.length)}]`,
          );
        } catch (err) {
          missing.push(name);
          const message = err instanceof Error ? err.message : String(err);
          console.log(`[err ] (${String(fetched.length + 1)}) [W${workerId}] ${name} ${message}`);
          activeWorkers -= 1;
          continue;
        }
        activeWorkers -= 1;
      }

      if (content !== null) {
        fetched.push({ name, bytes, sha256: hash });
        enqueue(extractRefs(content, kind));
      }
    }
  };

  const workers = Array.from({ length: concurrency }, (_, i) => worker(i + 1));
  await Promise.all(workers);

  // ---- 3. 报告 ----
  console.log("");
  console.log("=".repeat(70));
  console.log(`已抓取   ${String(fetched.length)} 个文件`);
  console.log(`总字节   ${String(fetched.reduce((sum, f) => sum + f.bytes, 0))}`);
  console.log(`待抓队列 ${String(queue.length)}`);
  console.log(`缺失     ${String(missing.length)}`);
  if (queue.length > 0) {
    console.log("");
    console.log("提示：本次因 --limit 提前结束。再次运行同一命令会跳过已抓文件继续。");
  }
  if (missing.length > 0 && missing.length <= 20) {
    console.log("");
    console.log("缺失清单：");
    for (const name of missing) console.log(`  ${name}`);
  }
  console.log("=".repeat(70));

  if (dryRun) return 0;

  // ---- 4. 清单（漂移检测基线）----
  const manifest = {
    source: origin,
    fetchedAt: new Date().toISOString(),
    shellBytes: utf8ByteLength(shellHtml),
    shellSha256: await sha256Hex(UTF8.encode(shellHtml)),
    files: fetched.sort((a, b) => a.name.localeCompare(b.name)),
    missing: missing.sort(),
  };
  await Deno.writeTextFile(
    posix.join(outDir, "manifest.json"),
    JSON.stringify(manifest, null, 2),
  );
  console.log(`清单已写出: ${posix.join(outDir, "manifest.json")}`);

  // ---- 5. 入口 bundle 的 patch 可行性检查（只读，不改写）----
  const entry = fetched.find((f) => /^index-.*\.js$/.test(f.name));
  if (entry === undefined) {
    console.log("");
    console.log("未找到入口 bundle（index-<hash>.js）。");
    console.log("若本次因 --limit 提前结束，重跑本命令继续抓取后再检查。");
    return 0;
  }

  const anchors = inspectAnchors(await Deno.readTextFile(posix.join(assetsDir, entry.name)));
  console.log("");
  console.log(`入口 bundle: ${entry.name}`);
  if (anchors.patchable) {
    console.log("patch 锚点: 可直接 patch");
  } else if (anchors.alreadyPatched) {
    console.log("patch 锚点: 已被 patch 过（磁盘上不应出现，请确认是否手工改过）");
  } else {
    console.log(
      `patch 锚点: 不匹配（overrideUrl:void 0 × ${String(anchors.overrideCount)}，` +
        `上下文锚点 × ${String(anchors.functionCount)}，均应为 1）`,
    );
    console.log("           厂商构建可能已变化，见 docs/patching.md §5");
  }
  console.log("");
  console.log("抓取不改写任何文件，vendor-assets 与厂商站一一对应，manifest.json 可校验。");
  console.log("relay patch 在启动服务时套用（内存 overlay），见 docs/deploy.md §2.2。");
  return 0;
}

Deno.exit(await main());
