/**
 * SPA patch 与漂移检测。原理与流程见 docs/patching.md。
 *
 * 厂商 SPA 的 relay 地址由单一函数决定，且 overrideUrl 被写死：
 *   function B4t(){ return Mae({ endpointOrigin: `https://zcode.z.ai`, overrideUrl: void 0 }) }
 *
 * 本工具把 overrideUrl 的取值改成运行时查找，使同一份构建可在部署时配置，
 * 且全部查找失败时回退厂商地址（失败安全）。
 *
 * 两点约束：
 *  - **按字符串锚点 patch，绝不按字节偏移**——偏移每次构建都会变。
 *  - 浏览器无完整性校验，故 patch 后可直接服务；但厂商每次发布新构建都要重新 patch。
 */

/** 需要替换的锚点。必须恰好出现一次，否则拒绝 patch。 */
export const OVERRIDE_ANCHOR = "overrideUrl:void 0";

/**
 * 上下文锚点，用于确认命中的确实是目标构建而不是同名片段。
 * 同样要求恰好出现一次。
 */
export const FUNCTION_ANCHOR = "function B4t(){return Mae({endpointOrigin:";

/**
 * 替换后的取值表达式。查找顺序：meta 标签 → 全局变量 → localStorage。
 * 全部为空时得到 undefined，Mae 会回退到厂商地址，因此 patch 本身不会
 * 造成硬故障。
 */
export const OVERRIDE_EXPRESSION =
  "overrideUrl:document.querySelector('meta[name=\"zcode-relay-ws\"]')?.content" +
  "||globalThis.__ZCODE_RELAY_WS__" +
  "||localStorage.getItem('zcode-relay-ws')" +
  "||void 0";

/** 供部署方写入 HTML 外壳的 meta 标签。 */
export function metaTag(relayUrl: string): string {
  return `<meta name="zcode-relay-ws" content="${relayUrl}" />`;
}

export function countOccurrences(haystack: string, needle: string): number {
  if (needle.length === 0) return 0;
  let count = 0;
  let index = haystack.indexOf(needle);
  while (index !== -1) {
    count += 1;
    index = haystack.indexOf(needle, index + needle.length);
  }
  return count;
}

export interface AnchorReport {
  readonly overrideCount: number;
  readonly functionCount: number;
  /** 是否可以直接 patch：两个锚点都必须恰好一次。 */
  readonly patchable: boolean;
  /** 是否看起来已经是 patch 过的（幂等性判断）。 */
  readonly alreadyPatched: boolean;
}

/** 检查锚点状态，用于漂移检测与幂等性判断。 */
export function inspectAnchors(source: string): AnchorReport {
  const overrideCount = countOccurrences(source, OVERRIDE_ANCHOR);
  const functionCount = countOccurrences(source, FUNCTION_ANCHOR);
  return {
    overrideCount,
    functionCount,
    patchable: overrideCount === 1 && functionCount === 1,
    alreadyPatched: overrideCount === 0 &&
      functionCount === 1 &&
      countOccurrences(source, OVERRIDE_EXPRESSION) === 1,
  };
}

export class PatchError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PatchError";
  }
}

/**
 * 应用 patch。幂等：已 patch 过的输入原样返回，不报错。
 * 锚点缺失或重复出现时抛 PatchError——静默跳过会让部署方以为成功了。
 */
export function applyRelayPatch(source: string): string {
  const report = inspectAnchors(source);

  if (report.alreadyPatched) return source;

  if (report.overrideCount !== 1) {
    throw new PatchError(
      `锚点 "${OVERRIDE_ANCHOR}" 出现 ${report.overrideCount} 次，期望恰好 1 次。` +
        `厂商构建可能已变化，请对照 docs/patching.md §5 重新确认 patch 面。`,
    );
  }
  if (report.functionCount !== 1) {
    throw new PatchError(
      `上下文锚点出现 ${report.functionCount} 次，期望恰好 1 次。可能不是目标构建。`,
    );
  }

  return source.replace(OVERRIDE_ANCHOR, OVERRIDE_EXPRESSION);
}
