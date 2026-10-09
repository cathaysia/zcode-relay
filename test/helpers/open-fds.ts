/**
 * 统计本进程持有的普通文件描述符数量。
 *
 * 为什么非要用外部工具：这个数字有三条被实测否掉的路——
 *   - `process.getActiveResourcesInfo()` 看不到被暂停的 ReadStream 持有的 fd；
 *   - `process.report.getReport()` 的 libuv 段里也没有它；
 *   - `/dev/fd` 的枚举在 macOS 上不可靠（同一进程两次读数不一致）。
 * lsof 是唯一与观测一致的口径，它列出的 REG 行数正是泄漏量。
 *
 * lsof 不存在时返回 null——调用方应当**跳过**断言，而不是当成通过。
 */

import { execFileSync } from "node:child_process";

export function countRegularFds(): number | null {
  let out: string;
  try {
    out = execFileSync("lsof", ["-p", String(process.pid), "-Fftn"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
  } catch {
    return null;
  }

  // -F 输出是逐字段的分行记录：f<fd> / t<type> / n<name>。
  // 只数类型行，避免把路径里含 "REG" 的文件名算进去。
  let count = 0;
  for (const line of out.split("\n")) {
    if (line.startsWith("t") && line.slice(1).trim() === "REG") count += 1;
  }
  return count;
}
