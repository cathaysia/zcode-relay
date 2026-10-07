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
| WS 接入层 | 完成 |
| 单元测试 + 端到端测试 | 53 个用例全绿 |
| 协议核对工具（echo-relay） | 完成，已冒烟验证 |
| SPA patch 与漂移检测工具 | 完成，**已在真实厂商构建上验证可应用** |
| 资源递归抓取 | 未开始（流程见 docs/patching.md §4） |
| 部署与 VPN 绑定 | 未开始（需你的 VPN 与域名） |

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
| [docs/design.md](docs/design.md) | 设计方案：问题拆解、模块架构、BDD、接口 |
| [docs/protocol.md](docs/protocol.md) | 逆向得到的 relay 协议完整规范（实现依据） |
| [docs/patching.md](docs/patching.md) | SPA 提取、patch、漂移检测流程 |
| [docs/verification.md](docs/verification.md) | 所有前置结论的实测证据 |

## 范围

**只支持配对链接模式**（`/remote/v4?sid=&hash=&t=`）。厂商的 OAuth 登录模式
`/web-remote` 依赖厂商 OAuth 与 API，无法自托管，明确排除。
