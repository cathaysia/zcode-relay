/**
 * 资源依赖图提取。纯函数，便于测试。
 *
 * 流程与坑见 docs/patching.md §4：SPA 无 manifest，文件名带内容哈希且按名引用，
 * chunk 之间互相 import，必须递归抓取；其中约 370 个动态 import 目标不在
 * __vite__mapDeps 里，所以只靠 mapDeps 会漏。
 */

/** 站点根路径下的资源前缀。外壳与 chunk 里都用这个绝对路径。 */
export const ASSET_URL_PREFIX = "/remote/v4/latest/assets/";

/**
 * 相对引用。三种真实形式：
 *   import{a}from"./x.js"     静态导入
 *   import(`./x.js`)          动态导入
 *   import"./x.js"            副作用导入（无绑定）
 * 故 `import` 后的括号必须是可选的。
 */
const RELATIVE_REF = /(?:from|import)\s*\(?\s*["'`]\.\/([^"'`)]+)/g;

/** 绝对引用：`/remote/v4/latest/assets/x.js`（含 worker、图片、音频） */
const ABSOLUTE_REF = new RegExp(`${ASSET_URL_PREFIX.replace(/\//g, "\\/")}([^"'\`)>\\s]+)`, "g");

/** CSS 里的 url(...) */
const CSS_URL_REF = /url\(\s*["']?([^"')]+)["']?\s*\)/g;

/** 去掉查询串与锚点，只留文件名。 */
function cleanRef(ref: string): string {
  const withoutQuery = ref.split(/[?#]/)[0] ?? ref;
  const lastSegment = withoutQuery.split("/").pop() ?? withoutQuery;
  return lastSegment.trim();
}

/** 是否是我们会处理的资源（跳过 data: / http: / 空串）。 */
function isAssetName(name: string): boolean {
  if (name.length === 0) return false;
  if (name.startsWith("data:") || name.startsWith("http:") || name.startsWith("https:")) return false;
  if (name.startsWith("//")) return false;
  // 只取带扩展名的资源
  return /\.[A-Za-z0-9]{1,8}$/.test(name);
}

export type AssetKind = "html" | "js" | "css" | "other";

export function kindOf(name: string): AssetKind {
  if (name.endsWith(".html")) return "html";
  if (name.endsWith(".js") || name.endsWith(".mjs")) return "js";
  if (name.endsWith(".css")) return "css";
  return "other";
}

/**
 * 从一个文件内容里提取它引用的资源名（仅文件名，不含路径）。
 * 返回去重后的集合。
 */
export function extractRefs(content: string, kind: AssetKind): Set<string> {
  const found = new Set<string>();

  const patterns: RegExp[] =
    kind === "js"
      ? [RELATIVE_REF, ABSOLUTE_REF]
      : kind === "css"
        ? [CSS_URL_REF, ABSOLUTE_REF]
        : [ABSOLUTE_REF];

  for (const pattern of patterns) {
    pattern.lastIndex = 0;
    for (const match of content.matchAll(pattern)) {
      const raw = match[1];
      if (raw === undefined) continue;
      const name = cleanRef(raw);
      if (isAssetName(name)) found.add(name);
    }
  }
  return found;
}

/**
 * 从外壳 HTML 里提取入口脚本与预加载资源。
 * 外壳用的是 /remote/v4/latest/assets/... 绝对路径。
 */
export function extractShellRefs(html: string): Set<string> {
  return extractRefs(html, "html");
}
