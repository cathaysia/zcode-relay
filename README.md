# zcode-relay

自托管 ZCode Web 远控的 relay，替代厂商的 `wss://zcode.z.ai/ws`。

## 目标

把 ZCode 桌面端的 Web 远控链路从厂商 relay 切换到自托管 relay，满足：

- **不改厂商二进制**：`app.asar` 有 Electron 嵌入式完整性校验，任何篡改会 `process.exit(1)`。
- **不引入 MITM**：不劫持 DNS、不装自签 CA。
- **内容不经第三方**：桌面端、relay、Web 端三者都在自己的控制域内。

## 达成的路径

| 环节 | 手段 | 是否需要开发 |
|---|---|---|
| 桌面端 relay 地址 | 环境变量 `ZCODE_WEB_REMOTE_CONTROL_RELAY_WS_URL` | 否 |
| 桌面端二维码/链接地址 | 环境变量 `ZCODE_WEB_REMOTE_CONTROL_URL` | 否 |
| Web 端 relay 地址 | patch SPA 的 `B4t()`（浏览器无完整性校验） | 少量脚本 |
| relay 本体 | 本仓库实现 | 是（约数百行） |
| SPA 静态资源 | 提取 + 自托管 | 脚本 |
| 部署 | 只监听 VPN 接口 | 配置 |

关键不对称：**桌面端一行环境变量即可，Web 端才是成本所在。**

## 文档

| 文档 | 内容 |
|---|---|
| [docs/design.md](docs/design.md) | 设计方案：问题拆解、模块架构、BDD、接口 |
| [docs/protocol.md](docs/protocol.md) | 逆向得到的 relay 协议完整规范（实现依据） |
| [docs/patching.md](docs/patching.md) | SPA 提取、patch、漂移检测流程 |
| [docs/verification.md](docs/verification.md) | 所有前置结论的实测证据 |

## 范围

**只支持配对链接模式**（`/remote/v4?sid=&hash=&t=`）。厂商的 OAuth 登录模式 `/web-remote` 依赖厂商 OAuth 与 API，无法自托管，明确排除。

## 状态

设计阶段。协议已完整逆向并交叉验证（device 侧与 terminal 侧双向确认）。
