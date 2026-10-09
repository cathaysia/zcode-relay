# zcode-relay

自托管 ZCode Web 远控的 relay，替代厂商的 `wss://zcode.z.ai/ws`。

## 目标

把 ZCode 桌面端的 Web 远控链路从厂商 relay 切换到自托管 relay，满足：

- **不改厂商二进制**：`app.asar` 有 Electron 嵌入式完整性校验，任何篡改会 `process.exit(1)`。
- **不引入 MITM**：不劫持 DNS、不装自签 CA。
- **内容不经第三方**：桌面端、relay、Web 端三者都在自己的控制域内。

**能力边界**：本方案达成"内容不经第三方"，但**不是**"relay 看不到内容"。设备侧协议固定，首次注册必然把 `pass_hash` 交给 relay，且设备只提供这一个密钥材料，因此无法构造 relay 不可见的端到端加密。详见 [docs/design.md](docs/design.md) 的「不做端到端加密的说明」。

## 达成的路径

| 环节 | 手段 | 是否需要开发 |
|---|---|---|
| 桌面端 relay 地址 | 环境变量 `ZCODE_WEB_REMOTE_CONTROL_RELAY_WS_URL` | 否 |
| 桌面端二维码/链接地址 | 环境变量 `ZCODE_WEB_REMOTE_CONTROL_URL` | 否 |
| Web 端 relay 地址 | patch SPA 的 `B4t()`（浏览器无完整性校验） | 见 docs/patching.md |
| relay 本体 | 本仓库 | 已完成 |

关键不对称：**桌面端一行环境变量即可，Web 端才是成本所在。**

## 实现状态

| 模块 | 状态 |
|---|---|
| 协议层（crypto / limits / messages） | 完成（Web Crypto 实现） |
| relay 核心（认证 / 配对 / 路由 / 心跳 / 存活检测） | 完成 |
| 资源托管（Fastify 路由 + 外壳注入 relay 地址 + ETag 协商 + brotli 压缩） | 完成，已在真实资源上验证 |
| 资源抓取（递归依赖图 + 断点续抓 + 清单） | 完成，已在真实站点上验证 |
| 单端口部署入口（HTTP + WS 同端口，一个 Fastify 实例） | 完成，已端到端验证 |
| 单元测试 + 端到端测试（Deno test） | 149 个用例全绿 |
| 协议核对工具（echo-relay） | 完成，已冒烟验证 |
| SPA patch 与漂移检测工具 | 完成，**已在真实厂商构建上验证可应用** |
| TLS / VPN 绑定 | 未内置 TLS，建议上游反代，见 docs/deploy.md §3 |

## 怎么访问

**relay 本身不带 web**——它只服务 WebSocket。资源托管是独立模块，本仓库把它
和 relay 放进**同一进程、同一端口**（`src/serve/main.ts`），所以只需一张证书、
一个端口。完整部署步骤见 [docs/deploy.md](docs/deploy.md)。

### 常用命令工作流

```sh
# 1. 单机一键跑起全流程（自动启动 Relay + Tailscale 官方 HTTPS 反代 + 自动唤起 ZCode）
just up

# 2. 跨机器场景：在服务端（如 Linux / 云主机）仅启动 Relay 服务 + 反代
just serve

# 3. 跨机器场景：在桌面客户端仅启动 ZCode（支持传入远端 Relay 域名/IP）
just zcode https://<device>.<tailnet>.ts.net

# 4. 销毁与重置（清理下载的 SPA 镜像、重置 tailscale serve 反代配置）
just destroy
```

- `serve`：同端口提供 SPA 静态资源与 WebSocket relay，若本地有 Tailscale 则自动配置 `tailscale serve` 官方 HTTPS 反代（免自签证书风险）。若静态资源目录未初始化，会自动多线程并发抓取。
- `zcode [origin]`：自动注入 `ZCODE_WEB_REMOTE_CONTROL_RELAY_WS_URL` 与 `ZCODE_WEB_REMOTE_CONTROL_URL` 并启动桌面端，支持 macOS 和 Linux。
- `up`：`serve` 与 `zcode` 的一键编排启动。
- `destroy`：销毁已抓取的 vendor assets 缓存与重置 Tailscale 反代。

`serve` 会在启动前完成预检并把 relay patch 套在**内存 overlay** 上——磁盘上的
厂商资源始终是原始镜像，`manifest.json` 的 sha256 始终可校验。**预检不通过时
拒绝启动**，避免 SPA 悄悄连回厂商 relay 而你以为自托管成功了。

启动报告会直接根据操作系统打印可粘贴的桌面端配置：

**Linux (`~/.local/share/applications/zcode.desktop`):**
```
Exec=env \
  ZCODE_WEB_REMOTE_CONTROL_RELAY_WS_URL=wss://zcode.internal/ws \
  ZCODE_WEB_REMOTE_CONTROL_URL=https://zcode.internal/remote/v4 \
  /opt/ZCode/zcode %U
```

**macOS (终端启动 / 脚本 / `~/.zshrc`):**
```sh
export ZCODE_WEB_REMOTE_CONTROL_RELAY_WS_URL=wss://zcode.internal/ws
export ZCODE_WEB_REMOTE_CONTROL_URL=https://zcode.internal/remote/v4
open -a "/Applications/ZCode.app"
# 或直接运行二进制：
# ZCODE_WEB_REMOTE_CONTROL_RELAY_WS_URL=... ZCODE_WEB_REMOTE_CONTROL_URL=... /Applications/ZCode.app/Contents/MacOS/ZCode
```

relay 地址由服务端自动注入外壳的 meta 标签，不需要手改 HTML。

## 快速开始

```sh
just install
just test      # 95 个用例
just lint      # 类型检查（Node 的类型擦除不做检查，故单独一道）

# 启动 relay（默认 127.0.0.1:18899；部署时应改为 VPN 接口地址）
just relay <vpn-ip> 18899
```

设备端配置：

- **Linux**（`~/.local/share/applications/zcode.desktop` 的 `Exec` 前加 `env`）：
  ```
  ZCODE_WEB_REMOTE_CONTROL_RELAY_WS_URL=wss://<你的地址>:18899/ws
  ZCODE_WEB_REMOTE_CONTROL_URL=https://<你的地址>/remote/v4
  ```
- **macOS**（终端启动或写入环境）：
  ```sh
  export ZCODE_WEB_REMOTE_CONTROL_RELAY_WS_URL=wss://<你的地址>:18899/ws
  export ZCODE_WEB_REMOTE_CONTROL_URL=https://<你的地址>/remote/v4
  open -a "/Applications/ZCode.app"
  ```

## 先验证再联调

把真实桌面端指向 `echo-relay`，它会打印设备实际发出的报文，并用捕获到的
`pass_hash` 校验设备的 `proof`。**校验通过即证明本仓库的协议实现与真实
客户端一致**（编码、HMAC 构造、角色绑定）。

```sh
just echo-relay 127.0.0.1 18899
# 另一个终端（Linux）：
ZCODE_WEB_REMOTE_CONTROL_RELAY_WS_URL=ws://127.0.0.1:18899/ws /opt/ZCode/zcode
# 另一个终端（macOS）：
ZCODE_WEB_REMOTE_CONTROL_RELAY_WS_URL=ws://127.0.0.1:18899/ws /Applications/ZCode.app/Contents/MacOS/ZCode
# 然后在界面里开启「Web 远程控制」
```

这是写任何 SPA patch 之前的推荐起点——它能先证伪对协议的逆向结论。

## 技术栈

**Deno**（无构建步骤、无 `node_modules`）：TypeScript 直接跑在类型擦除上，
测试用内置 `deno test`，依赖与任务写在 `deno.json`。
HTTP 与 WebSocket 都跑在 **Fastify** 上（`@fastify/websocket`，内部即 `ws`）：
机制（路由、方法分派、HEAD、404/405、响应中断时的流清理）归框架，
缓存策略与内容协商归本仓库——分工与理由见 [docs/design.md](docs/design.md) §3，
硬约束见 [AGENTS.md](AGENTS.md)。

```sh
mise install      # 按 mise.toml 装 Deno
just install      # 拉依赖（deno install）
just test         # 全部测试
just lint         # deno check
```

## 文档

| 文档 | 内容 |
|---|---|
| [docs/deploy.md](docs/deploy.md) | 部署与访问：三条命令、自检清单、常见问题 |
| [docs/design.md](docs/design.md) | 设计方案：问题拆解、模块架构、BDD、接口 |
| [docs/protocol.md](docs/protocol.md) | 逆向得到的 relay 协议完整规范（实现依据） |
| [docs/patching.md](docs/patching.md) | SPA 提取、patch、漂移检测流程 |
| [docs/verification.md](docs/verification.md) | 所有前置结论的实测证据 |

## 范围

**只支持配对链接模式**（`/remote/v4?sid=&hash=&t=`）。厂商的 OAuth 登录模式
`/web-remote` 依赖厂商 OAuth 与 API，无法自托管，明确排除。
