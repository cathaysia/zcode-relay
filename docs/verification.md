# 实测证据

本方案依赖的每条承重结论及其验证方式。未经验证的推断在文中显式标注。

## A. 桌面端 relay 地址可覆盖

**结论**：`ZCODE_WEB_REMOTE_CONTROL_RELAY_WS_URL` 覆盖 relay 地址，值为空则回退硬编码；覆盖值不做任何校验。

```js
IP = process.env.ZCODE_WEB_REMOTE_CONTROL_RELAY_WS_URL?.trim(),
...
function xU(t){ let n = t?.overrideUrl?.trim();
  return n || (t?.endpointOrigin?.trim()===`https://zcode.chatglm.site` ? `wss://zcode.chatglm.site/ws` : Zx) }
// Zx = `wss://zcode.z.ai/ws`
```

**读取时机**：`app.asar/out/main/index.js` 模块作用域，即进程启动时读取一次，运行中修改无效。

**读取位置**：全库仅此一处（`rg -l ZCODE_WEB_REMOTE_CONTROL_RELAY_WS_URL` 只命中该文件）。

**无 settings 等价物**：未找到 `webRemoteControlRelay*` 之类的配置键，只能走环境变量。

## B. `ZCODE_BASE_URL` / `ZCODE_ENDPOINT_ORIGIN` **不**改变 relay

**结论**：这是最容易误判的一点。`xU` 中 `endpointOrigin` 只被用于一次相等判断（是否等于 `https://zcode.chatglm.site`），不等于则返回硬编码的 `wss://zcode.z.ai/ws`。因此把 API 域名改到自有域，relay 仍指向厂商。

虽然通用函数 `buildZCodeEndpointUrls` 会算 `relayWsUrl = ${origin}/ws`，但在远控路径上它被 `xU` 重新覆盖。

## C. Web 端 relay 地址硬编码

**结论**：厂商 SPA 永远连 `wss://zcode.z.ai/ws`，与页面托管位置无关。

```js
function B4t(){ return Mae({ endpointOrigin: `https://zcode.z.ai`, overrideUrl: void 0 }) }
```

两点决定性：

- `endpointOrigin` 是**字面量**，不是 `window.location.origin`。把 SPA 托管到自有域也无效。
- `overrideUrl: void 0` **显式写死**，封死覆盖路径。

**验证方式**：直接抓取公开资源 `https://zcode.z.ai/remote/v4/latest/assets/index-B-ilXaCQ.js` 并检索。该 SPA 无需登录即可加载外壳与资源。

**推论**：厂商 Web UI + 自建 relay 无法配对——桌面端连自建、Web 端连厂商，两者永不相遇。

## D. 二维码/链接 baseUrl 可覆盖

**结论**：链接 baseUrl 取 `ZCODE_WEB_REMOTE_CONTROL_URL ?? remoteUrl`，因此设该变量可让桌面端直接产出指向自托管 SPA 的链接。

```js
EP = process.env.ZCODE_WEB_REMOTE_CONTROL_URL?.trim()
...
getEndpointUrls: { relayWsUrl: ic({...}), remoteUrl: EP || e.remoteUrl }
mobileRemoteControlUrl: EP || mV.remoteUrl
...
let K = T?.remoteUrl ?? e.mobileRemoteControlUrl;
let Jr = sI(Jt, K, b.theme);   // sI = createQrUrl(baseUrl=K, ...)
```

这解决了「终端链接 origin 是否可配置」的问题：**可配置**，无需人工搬运 `sid`/`hash`/`t`。

## E. `app.asar` 完整性校验存在

**结论**：篡改 `app.asar` 会使进程 `exit(1)`，桌面端代码不可改。

**证据 1**：二进制中存在 Electron fuse 符号

```
$ strings -n 12 /opt/ZCode/zcode | grep -i 'asar.*integrit'
_ZN8electron5fuses40IsEmbeddedAsarIntegrityValidationEnabledEv
Integrity check failed for asar archive (
```

**证据 2**：asar fs 包装层中的校验实现

```js
function validateBufferIntegrity(t, e){
  if(!e) return;
  const s = D.createHash(e.algorithm).update(t).digest("hex");
  if(s !== e.hash){
    console.error(`ASAR Integrity Violation: got a hash mismatch (${s} vs ${e.hash})`);
    process.exit(1)
  }
}
```

**对比**：浏览器 SPA 无任何完整性或签名校验 → 可 patch。这是本方案只 patch Web 端的根本原因。

## F. 桌面端协议行为固定

**推论**（由 E 推出）：桌面端不可改，因此以下行为固定，relay 必须适配：

- 首次注册**必然**发送 `pass_hash`。
- 注册后持久化 `{device_sid, pass_hash}`，此后走 persisted 模式，**不再**发送 `pass_hash`。
- 设备重连后不会重置 `wasPaired`，故 relay 必须立即重发 `matched`。

**相关实现**（`MAIN`）：

```js
let te = await e.authStorageProvider.load(),
ve = te ? {mode:"persisted", deviceSid:te.deviceSid, passHash:te.passHash}
        : {mode:"register", passHash:e.authProvider.createPassHash(e.authProvider.createPassword())}
```

## G. 本地无可用于远控的监听地址

**结论**：不存在任何能驱动 agent 的本地监听器。这不是配置限制，是架构上不存在。

全库 `.listen(` 调用点共四类，全部绑 `127.0.0.1`：

| 监听器 | 地址 | 用途 | 能否驱动 agent |
|---|---|---|---|
| media preview 代理 | `127.0.0.1:<随机>` | 唯一路由 `GET/HEAD /__zcode_media/<token>`，流式返回已授权预览的文件字节 | 否，纯只读字节流 |
| cloud content media | `127.0.0.1:<随机>` | 按 key 返回已发布媒体资源 | 否 |
| off-peak mock gateway | `127.0.0.1:<固定>` | 伪造的模型接口 `/api/v1/off-peak/anthropic/v1/messages` | 否 |
| node REPL browser broker | `/tmp/znr-<uuid>.sock` | 代理浏览器操作 | 否，32 字节 token + `timingSafeEqual` |

**实测**：`curl http://127.0.0.1:40215/` 与 `/__zcode_media/` 均返回 `HTTP/1.1 404`（无 401 质询，即无需鉴权头，但缺 capability token）。

**需要更正的一处早期判断**：media preview 服务**不是**无鉴权。它有 256 位随机 token（`randomBytes(32).toString("hex")`）、2 小时过期、10 分钟空闲过期、路径限制在工作区内、512MB 单文件上限、并发上限 2、token 轮转。

**桌面↔host 通信**：stdio 管道（host 进程 fd 0 = `/dev/null`，fd 1/2 = socketpair），不是 TCP。

## H. `app-server` 只走 stdio

```js
// zcode.cjs，app-server 分支
return await runZCodeProtocolAgent({
  lifecycle, cwd, env,
  input:  n.protocolInput ?? e.stdin,   // stdin
  output: e.stdout,                     // stdout
  presentationSurface, prepareStorageOnly, version
})
```

官方帮助文本亦自述：`app-server  Run the ZCode Protocol stdio app server`。

**推论**：无法让 ZCode 的协议服务监听某个 IP；要远程需要把 stdio 套进 SSH。CLI 入口为 `node /opt/ZCode/resources/glm/zcode.cjs`（版本 0.16.9，已实测）。

## I. MITM 可行性（仅作备选路径记录，本方案不采用）

**结论**：证书校验被强制执行；Electron 的 Node 运行时**认** `NODE_EXTRA_CA_CERTS`；relay 连接无证书固定。

**实验设计**：自签 CA + 为 `zcode.z.ai` 签发的证书；用 ZCode 自带的 `ws` 8.20.0 连接 `127.0.0.1` 但以 `servername='zcode.z.ai'` 校验；运行在 `ELECTRON_RUN_AS_NODE=1 /opt/ZCode/zcode` 下。

| 条件 | 结果 |
|---|---|
| 无 `NODE_EXTRA_CA_CERTS` | `UNABLE_TO_VERIFY_LEAF_SIGNATURE` —— 拒绝 |
| 有 `NODE_EXTRA_CA_CERTS=ca.pem` | `RESULT=OK  ws 握手完成`，服务端日志 `收到 relay 连接! url=/ws?mid=test` |

**关键细节**：应用内置的 `httpProxyCaCertPath` 设置**不覆盖** relay —— 它最终调用 `e.setCertificateVerifyProc(i)`，那是 Electron/Chromium 会话级 API，而 relay 用的是主进程 `ws` 库（Node TLS），两套信任栈独立。relay 的连接构造无 agent、无 TLS 选项：

```js
new ll(t.toString(), { perMessageDeflate: !0, headers: { "X-Device-ID": ... } })
```

**本方案不采用 MITM 的理由**：`ZCODE_WEB_REMOTE_CONTROL_RELAY_WS_URL` 已提供零校验的直连覆盖，无需证书；MITM 需要自签 CA 且多一层运维负担。

## J. 任何包内均无 relay 服务端实现

- relay 协议消息（12 种）只出现在 device 侧 `out/main/index.js`。
- 全库检索 `relayServer` / `createRelay` / `deviceRegistry` / `forwardToClient` → 零命中。
- Web bundle 中无 GitHub 链接、无许可声明。

**结论**：relay 是闭源的厂商基础设施，无自托管支持。协议已完整逆向，故自建不需要官方开源。

**限制说明**：本次审计在无法网页检索的环境下进行，因此不能排除厂商在别处公开了 relay 实现；但客户端代码中没有任何自托管/私有部署的技术支撑痕迹。

## K. 凭据存储的实际强度（影响 §S5 设计决策）

`~/.zcode/v2/credentials.json` 用 `enc:v1:` AES-256-GCM 加密，但密钥在 `ZCODE_CREDENTIAL_SECRET` 未设置时回退为：

```
sha256("zcode-credential-fallback:" + platform + ":" + homedir + ":" + username)
```

**实测**：以该推导密钥解密，**7/7 条目全部成功**（OAuth access token、`zcodejwttoken`、user_info、relay pass_hash、两个 plan api-key）。

**对本方案的影响**：`pass_hash` 在设备侧的存储强度等同于文件权限（600）。因此 relay 侧「只驻内存」的策略把密钥暴露面压到与设备本地同级——若 relay 落盘，等于多一处同等强度的副本。

## 复现命令

```bash
# C: Web SPA 硬编码 relay
curl -sS https://zcode.z.ai/remote/v4/latest/assets/index-B-ilXaCQ.js -o index.js
rg -o 'overrideUrl:void 0' index.js            # 命中

# E: asar 完整性校验
strings -n 12 /opt/ZCode/zcode | grep -i 'asar.*integrit'

# G: 本地监听器
ss -tlnp | grep zcode
ss -xlp  | grep zcode

# H: app-server 只走 stdio
node /opt/ZCode/resources/glm/zcode.cjs --help | grep app-server
```

**审计产物位置**（临时目录，可删除）：asar 解包 `/tmp/zc-audit`，Web 资源 `/tmp/zcweb`，MITM 实验 `/tmp/zcmitm`。
