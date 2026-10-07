# SPA 提取、Patch 与漂移检测

## 1. Patch 面

relay 地址的唯一决策点：

```js
// index-<hash>.js，偏移 4803932–4804054
function B4t(){ return Mae({ endpointOrigin: `https://zcode.z.ai`, overrideUrl: void 0 }) }
```

唯一调用点在同文件的 terminal 控制器中：

```js
relayWsUrl: B4t(), deviceSid: t.deviceSid, passHash: t.passHash, ...
```

`Mae` 定义在共享 chunk（`src-<hash>.js`）中：

```js
function sf(e){ return e?.overrideUrl?.trim() ||
  (e?.endpointOrigin?.trim() === `https://zcode.chatglm.site` ? `wss://zcode.chatglm.site/ws` : Yd) }
const Yd = `wss://zcode.z.ai/ws`
```

**关键点**：改 `endpointOrigin` 无效——`sf` 只在它等于 chatglm 时特殊处理。`overrideUrl` 是第一分支且优先。

## 2. Patch 方案

把唯一的 18 字节串 `overrideUrl:void 0` 替换为运行时表达式：

```js
overrideUrl:document.querySelector('meta[name="zcode-relay-ws"]')?.content
  ||globalThis.__ZCODE_RELAY_WS__
  ||localStorage.getItem('zcode-relay-ws')
  ||void 0
```

性质：

- `B4t` 每次连接尝试都会调用，故取值是**每次实时读取**的。
- 全部为空时回退厂商 URL —— **失败安全**。
- 三种配置途径：自托管 HTML 里写 `<meta>`；控制台设全局变量；或在 localStorage 里设（无需重编 HTML 即可覆盖）。
- 查询参数（`?relay=`）也可行但持久性差。

**可选加固**：同时把共享 chunk 里的 `Yd`（唯一 17 字节串 `wss://zcode.z.ai/ws`）指向自建 relay 作为第二道保险。`Yd` 仅被 `sf` 引用，改动范围受控。

**不要用字节偏移打补丁**——偏移每次构建都会变。用精确字符串匹配。

## 3. 是否还有其他必须改的地址

在配对链接模式下（`/remote/v4?sid=&hash=&t=`），**只有 relay WS 一个地址需要重定向**，终端是纯 WS 的，不产生任何厂商 HTTP 调用。

| URL | 分类 |
|---|---|
| `wss://zcode.z.ai/ws`（经 `B4t`/`sf`） | **必须重定向** |
| `https://zcode.z.ai/docs`、反馈表单、`t.me`、`discord.gg` 等 | 可保留（纯链接/信息） |
| `https://zcode.z.ai` 作为 env/config 默认值（`apiBaseUrl`、`redirectUri`、coding-plan 相关） | 仅登录/分享/coding-plan 流程使用，terminal 不用 |
| `https://chat.z.ai/api/oauth/authorize` | 仅 OAuth 登录模式；**无法自托管** |
| `https://o.alicdn.com/captcha-frontend/...` | 仅认证流动态注入 |
| `/api/server-info`、`${relayOrigin}/api/remote-control/...` | 同源，自托管可控制 |

**结论**：OAuth 登录模式 `/web-remote` 依赖厂商 OAuth（`redirect_uri` 需厂商登记）与厂商 API，不可自托管。只支持配对链接模式。配对模式**不需要登录**，认证完全依赖配对密钥。

## 4. 资源提取

SPA 无 manifest、无 Service Worker、无 SRI。文件名带内容哈希且**按精确名引用**，chunk 之间互相 import，需递归抓取。

- HTML 外壳（约 20KB）加载 `index-<hash>.js` 及约 80 条 `modulepreload`。
- `index.js` 内嵌 `__vite__mapDeps`，约 **1757** 项（1756 个 js + 1 个 css）。
- 静态 import：48 个唯一目标。动态 import：**2024** 个唯一目标，其中 **370 个不在 mapDeps 中** —— 仅靠 mapDeps 不够。
- 另有按绝对路径引用的资源（不在 mapDeps）：`diffs.worker-*.js`（`new Worker(...,{type:'module'})`）、若干 PNG、一个 MP3，路径均为 `/remote/v4/latest/assets/`。

提取流程：

```sh
mkdir -p assets && cd assets
curl -sS https://zcode.z.ai/remote/v4/latest/ -o ../index.html
grep -oE '/remote/v4/latest/assets/[^"]+' ../index.html | xargs -n1 basename | sort -u > ../list.txt
touch ../seen.txt
while :; do
  sort -u ../list.txt | comm -23 - ../seen.txt > ../todo.txt
  [ -s ../todo.txt ] || break
  while read -r f; do
    curl -fsS "https://zcode.z.ai/remote/v4/latest/assets/$f" -o "$f" || { echo "MISS $f"; continue; }
    case "$f" in
      *.js) grep -oE '(from"\./|import\(`\./)[^"`]+' "$f" | sed -E 's/^(from"\.\/|import\(`\.\///' >> ../list.txt
            grep -oE '`/remote/v4/latest/assets/[^`]+`' "$f" | tr -d '`' | xargs -r -n1 basename >> ../list.txt ;;
      *.css) grep -oE 'url\([^)]*\)' "$f" | sed -E "s/url\(['\"]?//; s/['\"]?\)//" >> ../list.txt ;;
    esac
    echo "$f" >> ../seen.txt
  done < ../todo.txt
done
```

**校验要点**：该站对未知路径做 SPA fallback（连 `/assets/` 都返回外壳 HTML）。因此必须校验 `content-type` 并排除等于外壳大小（20641 字节）的响应，否则会把 HTML 当资源保存。

**托管要求**：所有资源必须在**同一源的精确路径** `/remote/v4/latest/assets/` 下提供——worker、PNG、MP3 用的是绝对路径引用，模块语义与 `crossorigin` 也依赖该路径。换源需要 CORS 且仍要改写这些绝对引用，不推荐。

## 5. 漂移检测与升级

现状：

- **无运行时版本清单**：`version.json` / `manifest.json` / `latest.json` 均 404，代码也不去取。
- **无 Service Worker、无自更新**：全库无 `navigator.serviceWorker` / `workbox` / `caches.*`。
- 缓存头：外壳 `no-store`（每次重新校验）；哈希资源 `max-age=31536000, immutable`。
- 已打开的标签页会继续跑它已加载的版本；新访问拿到新构建。

**真实失效模式**：钉住的自托管副本不会感知厂商发布，会一直工作；出问题是在**桌面端升级**、改变了终端必须说的协议时。配对契约是共享 chunk 里的链接参数解析（`sid`/`hash`/`t`/`mid`/`name`/`app_version`/`theme`）与 relay 帧/关闭码协议。

**检测信号**：外壳引用的 `index-<hash>.js` 文件名与其 md5，加上共享 chunk 的 md5。

**当前基线**（2026-10-07 抓取）：

| 文件 | md5 | 大小 |
|---|---|---|
| `index-B-ilXaCQ.js` | `c298edefcbbe07f2c4c1fa194255a3cb` | 4821509 |
| `src-wmk2orCZ.js` | `0f796ea3f90028ce7be885e4f8c89a38` | 37293 |

**重新 patch 流程**：

1. 重取外壳，比对 `index-*.js` 名称/哈希与钉住值。
2. 若变化，重跑 §4 的全量提取。
3. 断言三个锚点各恰好出现一次：`function B4t(){return Mae({endpointOrigin:`、`overrideUrl:void 0`、`Yd=`wss://zcode.z.ai/ws``。
4. 用字符串匹配（非偏移）重新打补丁。
5. 对 `sf`、链接参数解析、关闭码表做 diff，评估协议漂移。
6. 用 staging relay 跑通配对握手与帧往返。
7. 保留上一版作为回滚。

## 6. 其他运维事实

- **无 Service Worker**（不会把旧构建钉住）。
- **无 SRI**（外壳只在 module script/preload 上带 `crossorigin`；preload helper 仅在标签自带 `integrity` 时转发）。
- **无 CSP**（外壳既无 meta 也无响应头）。
- **配对模式无需登录**；认证即配对密钥 + relay 侧会话。
- **localStorage 键**：`zcode-theme`、`zcode-web-remote-client-id:<deviceSid>`（按源生成）、`zcode-cua-permission-status`、若干 UI 偏好。无 IndexedDB，SPA 不使用 Cookie。自托管源会自己生成 client id，**无需迁移任何状态**。

## 7. 合规说明

SPA 资源是厂商著作权代码，无许可头。自托管意味着复制并再分发这些代码、并对外提供被修改的字节；即便修改本身是出于互操作目的，这也可能与厂商服务条款或许可条款冲突。**仅为个人使用而在本地修改一份副本**，与**向他人分发被修改的资源包或运营公开 relay**，风险等级差异很大。

这是事实陈述，不是法律意见。若计划涉及分发或公开运营，应先取得针对适用条款的法律意见。
