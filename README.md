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
| 协议层（crypto / limits / messages） | 完成 |
| relay 核心（认证 / 配对 / 路由 / 心跳） | 完成 |
| 资源托管（HTTP + 外壳注入 relay 地址） | 完成，已在真实资源上验证 |
| 资源抓取（递归依赖图 + 断点续抓 + 清单） | 完成，已在真实站点上验证 |
| 单端口部署入口（HTTP + WS 同端口） | 完成，已端到端验证 |
| 单元测试 + 端到端测试 | 80 个用例全绿 |
| 协议核对工具（echo-relay） | 完成，已冒烟验证 |
| SPA patch 与漂移检测工具 | 完成，**已在真实厂商构建上验证可应用** |
| TLS / VPN 绑定 | 未内置 TLS，建议上游反代，见 docs/deploy.md §3 |

## 怎么访问

**relay 本身不带 web**——它只服务 WebSocket。资源托管是独立模块，本仓库把它
和 relay 放进**同一进程、同一端口**（`src/serve/main.ts`），所以只需一张证书、
一个端口。完整部署步骤见 [docs/deploy.md](docs/deploy.md)。

三条命令：

```sh
just fetch-assets ./vendor-assets             # 抓资源（只读，不改写任何文件）
just serve 10.8.0.1 8899 ./vendor-assets https://zcode.internal
# 按启动时打印的配置改桌面端 .desktop，重启 ZCode，开「Web 远程控制」，扫码
```

`serve` 会在启动前完成预检并把 relay patch 套在**内存 overlay** 上——磁盘上的
厂商资源始终是原始镜像，`manifest.json` 的 sha256 始终可校验。**预检不通过时
拒绝启动**，避免 SPA 悄悄连回厂商 relay 而你以为自托管成功了。

启动报告会直接打印可粘贴的桌面端配置：

```
Exec=env \
  ZCODE_WEB_REMOTE_CONTROL_RELAY_WS_URL=wss://zcode.internal/ws \
  ZCODE_WEB_REMOTE_CONTROL_URL=https://zcode.internal/remote/v4 \
  /opt/ZCode/zcode %U
```

relay 地址由服务端自动注入外壳的 meta 标签，不需要手改 HTML。

## 快速开始

```sh
just install
just test      # 42 个用例
just lint      # 类型检查（Node 的类型擦除不做检查，故单独一道）

# 启动 relay（默认 127.0.0.1:8899；部署时应改为 VPN 接口地址）
just relay <vpn-ip> 8899
```

设备端配置（`~/.local/share/applications/zcode.desktop` 的 `Exec` 前加 `env`）：

```
ZCODE_WEB_REMOTE_CONTROL_RELAY_WS_URL=wss://<你的地址>:8899/ws
ZCODE_WEB_REMOTE_CONTROL_URL=https://<你的地址>/remote/v4
```

## 先验证再联调

把真实桌面端指向 `echo-relay`，它会打印设备实际发出的报文，并用捕获到的
`pass_hash` 校验设备的 `proof`。**校验通过即证明本仓库的协议实现与真实
客户端一致**（编码、HMAC 构造、角色绑定）。

```sh
just echo-relay 127.0.0.1 8899
# 另一个终端：
ZCODE_WEB_REMOTE_CONTROL_RELAY_WS_URL=ws://127.0.0.1:8899/ws /opt/ZCode/zcode
# 然后在界面里开启「Web 远程控制」
```

这是写任何 SPA patch 之前的推荐起点——它能先证伪对协议的逆向结论。

## 技术栈

TypeScript 直接跑在 Node 24 的类型擦除上：**无构建步骤**，测试用内置
`node:test`，唯一运行依赖是 `ws`。约束见 [AGENTS.md](AGENTS.md)。

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
