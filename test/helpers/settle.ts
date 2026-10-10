/**
 * 让事件循环再跑一小段，把刚排定的收尾 timer 跑完。
 *
 * 为什么需要它：HTTP/WS 服务的 `shutdown()` 还会排一个
 * 短延时（实测 1–2 ms）的清理 timer。Deno 的 op 泄漏检查是**按用例**归属
 * op 的，这个 timer 若跨过用例边界就会被判成"泄漏"（前一个用例报
 * started-but-never-completed，后一个用例报 started-before-but-completed）。
 * 等它跑完再结束用例，检查就干净了；这不是产品行为的一部分，
 * 故只出现在测试侧，不进 `close()` 本身。
 *
 * 取值 5 ms：实测 1 ms 已足够，留一点余量给慢机器。
 */
export const SETTLE_MS = 5;

export function settleEventLoop(ms: number = SETTLE_MS): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
