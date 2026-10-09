# 部署与访问

## 0. 三个角色

```
        ┌──────────────────────────────────────────┐
        │           一台自控主机（VPN 内）          │
        │                                          │
        │   zcode-relay（单进程、单端口）           │
        │     ├── HTTP   /remote/v4/**   SPA 资源   │
        │     └── WS     /ws             relay      │
        └──────────────────────────────────────────┘
                    ▲                    ▲
        wss 出站    │                    │    https + wss
                    │                    │
        ┌───────────┴──────┐   ┌─────────┴────────────┐
        │  桌面端 ZCode     │   │  手机 / 浏览器        │
        │  （设备角色）     │   │  （terminal 角色）    │
        └──────────────────┘   └──────────────────────┘
```

**relay 本身不带 web。** 它只服务 WebSocket；资源托管是独立模块，本仓库把两者
放进**同一个进程、同一个端口**（`src/serve/main.ts`），这样只需要一张证书、
一个端口，也避免 SPA 是 https 而 relay 是 ws 的混合内容问题。

## 1. 为什么必须同源同路径

patch 后的 SPA 从三个地方按优先级查 relay 地址：`<meta name="zcode-relay-ws">`
→ `globalThis.__ZCODE_RELAY_WS__` → `localStorage`。所以 relay 地址**技术上可以
跨源**（WebSocket 不受 CORS 限制），但资源路径不行：

外壳里 worker、PNG、MP3 用的是**绝对路径** `/remote/v4/latest/assets/...`，
ES module 语义也依赖同源。因此资源必须托管在**同一源的精确路径**下。

本仓库的服务端会自动把 relay 地址注入外壳的 meta 标签，**不需要手改 HTML**。

## 2. 部署步骤

### 2.1 抓取资源

先小批量验证，再全量。全量约 2100 个文件，工具默认串行 + 50ms 间隔。

```sh
# 小批量验证（约 3 个请求）
just fetch-assets ./vendor-assets --limit 3

# 确认无误后全量；可重复运行，已抓的会跳过（断点续抓）
just fetch-assets ./vendor-assets
```

**抓取不改写任何文件**：抓下来的树是厂商资源的忠实镜像，`manifest.json` 里的
sha256 始终可校验，重新抓取也不会与 patch 打架。

产出：

| 文件 | 内容 |
|---|---|
| `vendor-assets/index.html` | 外壳 |
| `vendor-assets/assets/**` | 带内容哈希的 chunk 与静态资源 |
| `vendor-assets/manifest.json` | 抓取清单与各文件 sha256，用于漂移检测 |

`vendor-assets/` 已在 `.gitignore` 中——那是厂商著作权代码，不要提交。

### 2.2 启动服务（自动完成 patch）

```sh
# 本机自测
just serve 127.0.0.1 18899 ./vendor-assets http://127.0.0.1:18899

# 部署：绑到 VPN 接口，给出对外地址（用于推导 wss 与二维码链接）
just serve 10.8.0.1 18899 /srv/zcode-relay/vendor-assets https://zcode.internal
```

启动前会做**预检**并把两处改写套在**内存 overlay** 上，磁盘上的厂商资源保持原样：

| 改写 | 位置 | 目的 |
|---|---|---|
| 注入 `<meta name="zcode-relay-ws">` | 外壳 | 告诉 SPA relay 地址，无需手改 HTML |
| 套用 relay patch | 入口 `index-<hash>.js` | 让 `B4t()` 读取上面的 meta |

预检报告形如：

```
预检
  外壳        20707 字节
  入口 bundle index-B-ilXaCQ.js
  relay patch applied
              内存 overlay：4821509 → 4821644 字节（磁盘文件未改动）
```

**预检不通过时拒绝启动**。`app.asar` 的教训是"静默失败最贵"——如果 anchors
不匹配而照常启动，SPA 会**悄悄连回厂商 relay**，你以为自托管成功了其实没有。
所以这里选择硬失败，附上排查步骤；仅排查时可用 `ZCODE_SERVE_ALLOW_UNPATCHED=1`
强制启动。

三个开关（排查用）：

| 环境变量 | 作用 |
|---|---|
| `ZCODE_SERVE_NO_PATCH=1` | 跳过入口 patch（SPA 连回厂商 relay） |
| `ZCODE_SERVE_ALLOW_UNPATCHED=1` | 预检失败仍启动 |
| `ZCODE_RELAY_PATH` | 改 WebSocket 路径（默认 `/ws`） |

### 2.3 为什么用内存 overlay 而不是原地改文件

原地 patch 有四个实际问题，overlay 全部避开：

1. **清单失去意义**——`manifest.json` 的 sha256 是抓取时算的，原地改写后对不上，
   漂移检测就没有可信基线了。
2. **无法区分原始与已 patch**——出问题时无法判断磁盘上那份是否被动过。
3. **与重新抓取冲突**——重抓会覆盖 patch，或让工具误判"已存在"而跳过。
4. **入口 bundle 的缓存头必须变**——内容已与文件名里的哈希不符，不能再宣称
   `immutable`（否则浏览器把打过补丁的版本钉住一年，将来换 relay 地址无法更新）。
   overlay 方案能精确地只对这个文件用 `no-cache` 加一个强 ETag：浏览器留副本，
   但复用前回源校验一次，未变时回 304——重复访问的流量从整个入口降到一次条件请求。

若你打算用 nginx 之类的静态服务器而不是内置的 asset server，则需要一份落在磁盘上的
patch 产物：

```sh
just patch-check ./vendor-assets/assets/index-<hash>.js
just patch-apply ./vendor-assets/assets/index-<hash>.js ./patched/index-<hash>.js
```

注意此时**必须自行处理 meta 注入与缓存头**——这两件事内置服务已代劳。

### 2.4 配置桌面端

**Linux**：编辑 `~/.local/share/applications/zcode.desktop`，在 `Exec` 前加 `env`：

```ini
Exec=env \
  ZCODE_WEB_REMOTE_CONTROL_RELAY_WS_URL=wss://zcode.internal/ws \
  ZCODE_WEB_REMOTE_CONTROL_URL=https://zcode.internal/remote/v4 \
  /opt/ZCode/zcode %U
```

**macOS**：通过终端启动或写入环境（macOS 应用默认不读取 shell 配置文件）：

```sh
# 方式 A：终端直接通过 open 传入环境变量
export ZCODE_WEB_REMOTE_CONTROL_RELAY_WS_URL=wss://zcode.internal/ws
export ZCODE_WEB_REMOTE_CONTROL_URL=https://zcode.internal/remote/v4
open -a "/Applications/ZCode.app"

# 方式 B：直接执行可执行文件（排查时推荐，能看到所有标准输出）
ZCODE_WEB_REMOTE_CONTROL_RELAY_WS_URL=wss://zcode.internal/ws \
ZCODE_WEB_REMOTE_CONTROL_URL=https://zcode.internal/remote/v4 \
/Applications/ZCode.app/Contents/MacOS/ZCode
```

两个变量分工不同，缺一不可：

| 变量 | 作用 |
|---|---|
| `ZCODE_WEB_REMOTE_CONTROL_RELAY_WS_URL` | 桌面端**连到哪里**（relay） |
| `ZCODE_WEB_REMOTE_CONTROL_URL` | 二维码**指向哪里**（SPA 入口） |

两者都只在进程启动时读取，必须重启 ZCode 生效。

**注意**：`ZCODE_BASE_URL` / `ZCODE_ENDPOINT_ORIGIN` **不影响** relay，别用它们。

### 2.5 访问

重启 ZCode → 界面里开启「Web 远程控制」→ 用手机扫桌面端显示的二维码。

手工等价的地址：

```
https://zcode.internal/remote/v4?sid=<device_sid>&hash=<pass_hash>&t=<ts>
```

## 3. TLS

浏览器要求：SPA 走 https 时 relay 必须是 wss（否则混合内容被拦）。

两条路：

- **在上游放反向代理**（nginx/caddy）终止 TLS，转发到本服务的 18899。这是推荐做法——证书续期、HTTP/2、访问日志都由代理负责。
- 或让本服务直接用证书启动，但当前实现未内置 TLS，需要自行包一层。

若只在 VPN 内且所有客户端都接受 http，可以不改；但手机浏览器对 http 页面的
限制较多（部分 API 不可用），建议还是上 TLS。

## 4. 自检清单

```sh
# 端口在听（Linux: ss，macOS: lsof）
ss -tlnp | grep 18899              # Linux
lsof -iTCP:18899 -sTCP:LISTEN      # macOS

# 状态页（会打印资源根目录与端点）
curl -s http://127.0.0.1:18899/

# 外壳，并确认 relay 地址已注入
curl -s http://127.0.0.1:18899/remote/v4 | grep -o 'zcode-relay-ws[^>]*'

# 入口 bundle，确认类型与缓存头（应为 no-cache 且带 ETag，不应是 immutable）
curl -sI http://127.0.0.1:18899/remote/v4/latest/assets/index-<hash>.js

# 缓存协商是否生效：第二条命令应回 304 且不带正文
ET=$(curl -sI http://127.0.0.1:18899/remote/v4/latest/assets/index-<hash>.js \
     | sed -n 's/^[Ee][Tt]ag: *//p' | tr -d '\r')
curl -sI -H "If-None-Match: $ET" \
     http://127.0.0.1:18899/remote/v4/latest/assets/index-<hash>.js | head -1

# 压缩是否生效：应看到 content-encoding: br，且 content-length 只有原来的约四分之一
curl -sI -H 'Accept-Encoding: br' \
     http://127.0.0.1:18899/remote/v4/latest/assets/index-<hash>.js \
     | grep -i -E 'content-encoding|content-length|vary'

# relay 是否可用（应先跑通协议核对工具）
just echo-relay 127.0.0.1 18899
```

推荐顺序：**先用 `echo-relay` 让真实桌面端连一次**，确认它能完成注册与认证，
再去抓资源。这样任何协议偏差会在引入 SPA 之前就暴露出来。

## 5. 常见问题

**扫码后一直停在「正在连接中转服务…」**
浏览器到不了 relay。检查 `ZCODE_WEB_REMOTE_CONTROL_RELAY_WS_URL` 用的是
`wss://` 且地址与端口可从手机侧访问；打开浏览器控制台看 WebSocket 错误。

**页面白屏 / 资源 404**
资源抓取不全。`manifest.json` 的 `missing` 字段列出失败的项；重新运行
`just fetch-assets` 断点续抓。注意该站对未知路径做 SPA fallback——工具已
按 content-type 识别这种情况，若你手工抓取需要自己判断。

**一直「等待桌面端配对」**
桌面端的 `sid` 与二维码不一致，或桌面端连的是厂商 relay 而浏览器连的是你
的。核对两边打印的 relay 地址是否相同。

**厂商发布新版本后行为异常**
先跑漂移检测：`just patch-check <index-<hash>.js>`。锚点计数不为 1 说明
patch 面变了，按 `docs/patching.md §5` 重新确认。

**relay 重启后二维码失效**
预期行为。`pass_hash` 只驻内存不落盘（见 `docs/design.md §S5`），重启后
设备会收到 `AUTH_FAILED` 并自动重新注册，到桌面端重新开启一次即可。
