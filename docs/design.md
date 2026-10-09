# 自托管 ZCode Web 远控 Relay — 设计方案

## 1. 问题陈述

ZCode 的 Web 远控把桌面端会话内容经厂商 relay 明文转发：

```
桌面端 ──wss──> wss://zcode.z.ai/ws <──wss── 浏览器 SPA
```

relay 是 TLS 终止点，双向载荷为纯 JSON（无端到端加密），且 relay 持有配对共享密钥 `pass_hash`——设备在首次注册时明文提交，同时该值就是客户端认证 HMAC 的密钥。后果：relay 可读全部会话内容，并可伪造任一侧身份。

目标：把 relay 换成自托管实现，使桌面端、relay、Web 端三者均在自有控制域内，且**不修改厂商二进制**、**不引入 MITM**。

约束来自实测（见 `verification.md`）：`app.asar` 有 Electron 嵌入式完整性校验，篡改即 `exit(1)`，故桌面端代码不可改、协议行为固定（首次注册必然发出 `pass_hash`）；浏览器 SPA 无完整性与签名校验，可 patch；桌面端与 SPA 各有且仅有一个 relay 地址决策点。

## 2. 子问题与解决策略

**S1 桌面端 relay 地址**：环境变量 `ZCODE_WEB_REMOTE_CONTROL_RELAY_WS_URL` 覆盖，空则回退硬编码；覆盖值零校验（接受 `ws://`）。主进程模块初始化时读取，须启动前注入。注意 `ZCODE_BASE_URL` / `ZCODE_ENDPOINT_ORIGIN` **不影响** relay——解析函数只在覆盖值为空时用 `endpointOrigin` 做一次相等判断，否则返回硬编码值。

**S2 Web 端 relay 地址**：SPA 的决策点是单一函数，且 `overrideUrl` 被写死：

```js
function B4t(){ return Mae({ endpointOrigin: `https://zcode.z.ai`, overrideUrl: void 0 }) }
```

策略：把 `overrideUrl:void 0` 替换为运行时表达式（`<meta>` → 全局变量 → localStorage 依次回退，全空则回退厂商地址）。单点、部署期可配、失败安全。该函数每次连接尝试都会调用，故取值实时读取。

**S3 链接入口**：二维码 baseUrl 取 `ZCODE_WEB_REMOTE_CONTROL_URL ?? remoteUrl`。设该变量即让桌面端直接产出指向自托管 SPA 的链接，无需人工搬运 `sid`/`hash`/`t`。

**S4 Relay 本体**：协议已从两侧完整逆向。relay 是**不透明转发器**——载荷 `rpc-frame` 是 base64 分片，relay 不需解析。职责仅四项：会话注册表、配对状态机、定向帧路由、心跳应答。

**S5 认证与信任边界（关键决策）**：设备侧协议固定，`pass_hash` 首次注册时必然到达 relay。两种可选姿态：

| 方案 | relay 持有 `pass_hash` | 终端认证强度 | 重连体验 |
|---|---|---|---|
| A 兼容 | 是（仅内存） | HMAC 挑战应答，强 | relay 重启后设备自动重注册 |
| B 最小化 | 否，只存 `H(pass_hash)` | 仅依赖 `device_sid` 保密性 | 同上 |

方案 A 与厂商等价（relay 可见密钥）但认证真实；方案 B 下 relay 不掌握密钥，代价是终端认证退化为"知道 `device_sid` 即可连接"。

**选定 A，但限定两点**：`pass_hash` 只驻内存不落盘；relay 只绑定 VPN 接口。理由——`device_sid` 会出现在二维码与浏览器历史中，作为唯一凭据过于脆弱；而"只驻内存 + 仅 VPN 可达"已把密钥暴露面压到与设备本地凭据存储同级（实测该存储的密钥可由公开信息推导，见 `verification.md` §K）。持久化被显式放弃：relay 重启后设备收到 `AUTH_FAILED`，自动清本地凭据并以同一 `pass_hash` 重新注册，行为自愈，仅丢失旧链接。

**S6 资源托管与漂移**：SPA 资源为内容哈希文件名、无 manifest、无 Service Worker、无 SRI。需递归提取全量资源（含动态 import 的 chunk），同源同路径托管（`/remote/v4/latest/assets/` 是硬编码绝对路径）。漂移以 `index-<hash>.js` 与协议 chunk 的哈希为检测信号，升级时按固定锚点字符串重新 patch，不依赖字节偏移。

**S7 部署与访问控制**：relay 与 SPA 同源部署，避免 CORS 与混合内容问题。relay 仅监听 VPN 接口；强制 `wss://`（SPA 在 https 下无法连 `ws://`）。

**S8 范围裁剪**：只支持配对链接模式。厂商 OAuth 模式 `/web-remote` 依赖厂商 OAuth（`redirect_uri` 需厂商登记）与厂商 API，排除。

### 备选方案与取舍

Web 端 relay 地址硬编码（`overrideUrl: void 0`），因此"终端如何到达自建 relay"存在三条路径，本项目选 A：

| 方案 | 原理 | 需要 | 未采纳原因 |
|---|---|---|---|
| **A 改 bundle**（选定） | 把 `overrideUrl:void 0` 改为运行时表达式 | 你自己的正常 TLS 证书 | — |
| B DNS 劫持手机侧 | 因 relay URL 是字面量 `zcode.z.ai`，在手机 VPN 内覆盖其 DNS 即可改道 | `zcode.z.ai` 的证书 + 手机装自签 CA | 引入自签 CA 与 MITM 运维负担；证书轮换、手机信任库管理都是持续成本；且需逐设备配置。方案 A 无此负担 |
| C 自写 Web 客户端 | 以 SPA 里的 `X2t` 为参考实现重写终端 | 完整终端 UI + 协议实现 | 工作量最大且无收益——终端 UI 是纯展示层，复用厂商构建不增加信任假设（它不接触密钥以外的任何秘密；`pass_hash` 本就在二维码里） |

补充：厂商 relay 被替换后，**设备侧协议仍然固定**（`pass_hash` 首次注册必然发出），所以三条路径在信任模型上没有差异——relay 都必须是自有且受控的。差异只在运维成本。

### 不做端到端加密的说明

理论上可让 relay 看不到内容：在 `{type:"data"}` 的 `payload` 内再套一层 AEAD。但**密钥必须是 relay 不知道的值**，而设备侧协议固定、只提供 `pass_hash` 作为共享密钥材料。由于设备在首次注册时把 `pass_hash` 明文交给 relay，任何由 `pass_hash` 派生的密钥都对 relay 可见，该加固在当前协议下不可实现。

可行的替代是 §S5 的方案 B（relay 不持有 `pass_hash`）——它让 relay 无法伪造身份，但仍无法阻止 relay 读取内容，因为设备侧不提供第二个密钥。**因此本项目的边界是：内容不经第三方，但 relay 在技术上仍可见内容。** 若要求 relay 对内容不可见，需要能修改设备侧协议，而 `app.asar` 的完整性校验排除了这条路径。

## 3. 模块架构（数据流视角）

数据流：设备与终端各自向 relay 建立一条 WSS；relay 按 `device_sid` 归组，配对成立后在两者之间逐字节转发 `data` 载荷。relay 不参与任何载荷语义。

| 模块 | 职责 | 输入 → 输出 |
|---|---|---|
| `ws-acceptor` | 接受 WS 升级，读取 `?mid=` 与 `X-Device-ID`，不做鉴权 | 连接 → 连接对象 |
| `liveness` | 主动 ping 证明连接还活着；只发 FIN 的对端靠它判死（Deno 平台差异，见不变式 7） | 连接 → 判死则 terminate |
| `authenticator` | 维护 nonce，校验 `proof = HMAC(pass_hash, nonce\|role\|sid)` | `auth_init`/`auth_response` → 通过 / `AUTH_FAILED` |
| `session-registry` | `device_sid → {pass_hash, device_conn, terminal_conn, pair_status}` | 注册 / 查询 / 淘汰 |
| `pairing` | 计算并广播 `waiting`/`matched`，抢占时发 `KICKED`，设备离线时发 `DEVICE_OFFLINE` | 连接状态变更 → 状态帧 |
| `router` | 同会话内设备与终端之间原样转发 `data` | 载荷 → 对端载荷 |
| `heartbeat` | 应答 `pair_status_query` | 查询 → `pair_status_ack` |
| `patch-tool` | 提取、patch、漂移检测 SPA 资源 | 厂商资源 → 自托管资源 |
| `asset-provider` | 静态托管的**策略**：内容协商、按表示的校验符、入口内存 overlay、路径越界判定 | 请求路径 → 该发哪份字节 |
| `http-front` | 传输**机制**：路由、方法分派、HEAD、404/405、流式响应与中断清理（Fastify） | HTTP → 资源 |

模块到文件的映射：`ws-acceptor` 与 `liveness` → `src/relay/accept.ts`、`src/relay/routes.ts`（Fastify 路由）与 `src/relay/liveness.ts`（独立模式的监听在 `src/relay/server.ts`）；`authenticator`、`pairing`、`router`、`heartbeat` 与 `session-registry` → `src/relay/relay.ts` 与 `src/relay/registry.ts`；`Conn` 抽象 → `src/relay/conn.ts`；`patch-tool` → `src/tools/*`；`asset-provider` → `src/assets/provider.ts`（内容协商与压缩在 `src/assets/encoding.ts`，校验符在 `src/assets/validators.ts`）；`http-front` → `src/assets/routes.ts`。单端口部署在 `src/serve/main.ts`：一个 Fastify 实例同时注册两侧路由。

**运行时是 Deno，HTTP 与 WS 都跑在 Fastify 上**（`fastify` + `@fastify/websocket`，后者内部就是 `ws`）。分工的口径是"机制归框架、语义归本仓库"：路由、方法分派、HEAD 的自动路由、404/405、请求响应管道、客户端中断时的流销毁都交给 Fastify；而缓存策略、按表示计算的校验符、`Vary` 的范围、哪些资源可压，都是照证据定下的领域判断，交给 `@fastify/static`/`@fastify/etag`/`@fastify/compress` 会改变它们（理由就是下面那组托管不变式）。同理，`@fastify/accept-negotiator` 在 `br;q=0, *` 上会选中 br，与 RFC 9110 §12.5.3 的"显式列出者优先于通配符"相悖，故协商仍用自己那份（`src/assets/encoding.ts`，有实测对照）。

**为什么把 relay 做成"笨管道"**：协议本身不带版本协商，`payload` 内部 schema 会随厂商升级而变，且应用层已有自己的分片、校验、ack 与降级机制。relay 若试图理解或规范化 `payload`，就会在厂商升级时成为故障点，并可能改写桥接身份三元组导致桥接永久降级。代价是 relay 无法做内容层面的过滤或审计——这对本项目的目标（内容不经第三方）无影响，因为 relay 与消费方同属自有控制域；若将来需要审计，正确的位置是终端侧解密之后，而非 relay。

关键不变式：

1. **relay 不解析 `payload`**。`rpc-frame` 含桥接身份三元组（`bridgeSessionId`/`bridgeGeneration`/`recoveryId`），改写任一项都会使客户端降级、桥接失效。可在 `{type:"data"}` 外层附加 `server_ts`，但不得改动 `payload` 内部。

   落实方式：派发只需信封的 `type` 一个字段，故 `parseInbound` 先用 256 字符的**有界头部扫描**取它；认出 `data` 就直接把原文交出去，绝不 `JSON.parse` 整条报文。大帧的 payload 可达 1 MiB，完整解析既违背本条不变式，实测也占每帧成本的 65%–77%（去掉后 64 KiB 帧的转发成本从 26 µs 降到 8 µs）。扫描不命中时回退完整解析，所以字段顺序异常的报文只是慢，不会错。帧长上限按**线上字节数**判定：WS 层已知长度就直接传进来，不必为一个 MiB 级字符串再编码一遍量长度。
2. **逐连接 FIFO 保序，不合并不拆分**。分片按 `seq` 连续校验，乱序或缺帧触发终端硬故障。
3. **`matched` 必须向双方广播，且设备重连后必须重发**。设备侧把重连后收到的 `waiting` 判为陈旧，会自行触发重连。
4. **`error.code` 只用协议定义的五个**。两侧把未知 code 视为致命且不重连。
5. **认证校验是异步的，但处理顺序必须仍是到达顺序**。Web Crypto 没有同步 HMAC（`crypto.subtle` 是唯一入口），故 `auth_response` 的校验挂在 `await` 上；若不在连接上串行化，同一连接的第二条 `auth_response` 会在第一条附着完成前被判成"无待验证挑战"，于是 `AUTH_FAILED` 插到 `auth_ack` 前面——而它在客户端是致命的。`RelayCore.#serializeAuth` 按连接串行化这条路径；`data` 转发不进队列，逐帧零额外开销。
6. **校验完成前断开的连接不得附着**。异步窗口期内对端可能已经断开，此时 `Conn.isOpen` 为假，认证路径必须放弃附着，否则会话会挂着一条死 socket 永远显示 `matched`。
7. **连接存活必须由 relay 主动证明**。Deno 的 `node:http` 兼容层**不上报**升级连接上对端的 TCP FIN：实测对端完成 WS 握手后直接关闭 socket（不给关闭帧），3 秒内 server 侧 socket 既无 `end` 也无 `close`，`ws` 也不报错，只有下次往那条连接写东西才会由 RST 带出来。而 relay 在设备静默时不会主动写它，于是"设备崩溃/断网"永远不会被发现，`DEVICE_OFFLINE` 与终端的 15 秒宽限期会双双变成死代码。故 relay 按 ws 官方的 isAlive 模式每 10 秒 ping 一次、两个周期无 pong 即判死（`src/relay/liveness.ts`）。协议明确允许 relay 主动 ping，且两侧客户端都会自动回 pong（`protocol.md` §11），因此对客户端无影响。回归测试见 `test/e2e.test.ts` 的设备掉线用例（用例里把周期压到 150 ms 才跑得快）。

完整消息目录、状态机、定时器常数、分片规则与边界情况见 `protocol.md`。

**asset-server（`asset-provider` + `http-front`）的托管不变式**（与 relay 无关，但同样是"照证据定、别照直觉定"的部分）：

1. **入口 bundle 一律回源校验**。它在内存里被 patch 过，内容已与文件名里的哈希不符，因此不得发 `immutable`（会把旧 relay 地址钉死一年），也不宜发 `no-store`（会让浏览器每次页面加载都重下整个入口，实测 4.6 MiB）。正确做法是 `no-cache` 加强 ETag：浏览器留副本、复用前回源校验一次、未变时回 304。是否命中按文件名形状（`assets/index-<hash>.js`）判定，而非 `prepare()` 探到的那个具体名字，以免这条不变量依赖调用顺序。
2. **磁盘流式发送必须让流在客户端中断时被销毁，不能只"暂停"**。最初用 `createReadStream(...).pipe(res)`：客户端断开时 `pipe` 只会 unpipe 并暂停源流，既不销毁它、也不触发 autoClose，于是每个中断请求永久泄漏一个文件 fd（实测 12 次中断泄漏 12 个，约两百次即 EMFILE）。迁移前改用核心原语 `stream.pipeline`；迁移到 Fastify 后由 `reply.send(stream)` 承担同一职责（响应结束或出错时销毁源流），源流也从 `node:fs` 的 `createReadStream` 换成 `Deno.open` 的 Web 流——Deno 的文件资源在流被取消时直接释放，而 `node:fs` 的 ReadStream 把 close 排到一个 `setTimeout` 上。回归测试见 `test/assets-abort.test.ts`，它用 lsof 直接数进程的 REG fd，不看实现。
3. **外壳与入口是内存缓冲，不参与流式路径**，因此上述 fd 风险只存在于那约 2500 个静态 chunk 上。
4. **压缩一律走 zlib 的异步接口，绝不用 `*Sync`**。relay 的帧转发与 asset server 同进程同事件循环，同步压入口那 4.6 MiB 会把这段时间的所有 WS 帧卡住。实测异步压一个 2.05 MiB 的 chunk 期间事件循环最大阻塞 2.0 ms，而同样内容同步压约需 25 ms。
5. **压缩的产物随表示变化**。br 与 identity 是同一资源的两种表示，故 ETag 必须按实际送出的字节计算，否则 304 会把 br 的指纹配到 identity 的字节上（`src/assets/validators.ts` 的 `strongEtag`）。凡是可能被压缩的资源都要声明 `Vary: Accept-Encoding`，**包括这次发的是原文的情况**，否则共享缓存可能把原文回给明确要求 br 的客户端。
6. **只压文本类且达阈值的资源**（`src/assets/encoding.ts` 的 `isCompressible`）。PNG/MP3/woff2 已是压缩格式，wasm 是二进制且单文件最大 4 MiB；树里约两千个几百字节的图标 chunk 由 1 KiB 阈值挡住。门槛按扩展名而非"内容可不可压"，否则每压一个文件都要先试一次。

实测收益（2026-10-09 抓取的构建）：首屏那 84 个资源合计 8.11 MiB，经 br 后 1.94 MiB，省 76%。入口 bundle 在迁移到 Deno/Fastify 后重新量过：identity 4,821,644 字节 → br 1,129,235 字节，解压后与 identity 逐字节一致（同一构建下旧的 Node 实测记为 1,130,750 字节，差异来自 zlib 版本，压缩比结论不变）。外壳与入口在 `prepare()` 时预热 br，故请求路径上是零压缩开销。

## 4. 可视化

### 4.1 握手与配对时序

```kroki-plantuml
@startuml
autonumber
participant "桌面端 (device)" as D
participant "relay" as R
participant "浏览器 (terminal)" as T

== 设备首次注册 ==
D -> R: device_register_init {device_mid, pass_hash, meta}
R -> D: device_register_ack {device_sid}
D -> R: auth_init {role:"device", device_sid}
R -> D: auth_challenge {nonce}
D -> R: auth_response {proof=HMAC(pass_hash, nonce|"device"|sid)}
R -> D: auth_ack {pair_status:"waiting"}
note right of D: 持久化 {device_sid, pass_hash}\n此后不再发 pass_hash

== 终端接入并配对 ==
T -> R: auth_init {role:"terminal", device_sid}
R -> T: auth_challenge {nonce}
T -> R: auth_response {proof=HMAC(pass_hash, nonce|"terminal"|sid)}
R -> T: auth_ack {pair_status:"matched"}
R -> D: pair_status_ack {pair_status:"matched"}
note over D,T: 双方 paired，双向 data 透传开始

== 稳态与心跳 ==
loop 每 8-12 秒
  D -> R: pair_status_query
  R -> D: pair_status_ack {pair_status:"matched"}
end
D -> R: data {payload: rpc-frame ...}
R -> T: data {payload: 原样}
T -> R: data {payload: rpc-frame-ack ...}
R -> D: data {payload: 原样}

== 设备离线 ==
D -x R: 断开
R -> T: error {code:"DEVICE_OFFLINE"}
note right of R: 会话保留不拆，终端有 15 秒宽限
D -> R: auth_init {role:"device", device_sid}
R -> T: pair_status_ack {pair_status:"matched"}

== 第二终端抢占 ==
T2 -> R: auth_init {role:"terminal", device_sid}
R -> T: error {code:"KICKED"}
note right of T: 进入 kicked，不再重连
@enduml
```

### 4.2 部署拓扑

```kroki-mermaid
flowchart TB
    subgraph VPN["VPN 网段（仅此处可达）"]
        R["relay<br/>wss://relay.vpn/ws"]
        A["asset-server<br/>/remote/v4/latest/"]
        DB[("session registry<br/>device_sid to pass_hash<br/>仅内存")]
        R --- DB
    end

    D["桌面端 ZCode<br/>RELAY_WS_URL=wss://relay.vpn/ws<br/>REMOTE_CONTROL_URL=https://relay.vpn/remote/v4"]
    T["手机浏览器<br/>扫码打开自托管 SPA"]

    D -->|"wss 出站"| R
    T -->|"wss 出站（patch 后 B4t）"| R
    T -->|"https 加载 SPA"| A

    X["厂商 relay<br/>wss://zcode.z.ai/ws"]
    D -.->|"已切断"| X
```

## 5. BDD 测试与伪代码

### 5.1 BDD（Gherkin）

```gherkin
场景: 终端配对成功
  假设 设备已认证且处于 waiting
  当 终端以有效 device_sid 发送 auth_init 且角色为 terminal
  并且 终端以 HMAC(pass_hash, nonce | "terminal" | device_sid) 应答挑战
  那么 relay 向终端返回 auth_ack 且 pair_status 为 "matched"
  并且 relay 向设备返回 pair_status_ack 且 pair_status 为 "matched"

场景: 设备重连后必须立即恢复 matched
  假设 设备与终端已配对
  当 设备断开后以 persisted 模式重新认证
  那么 relay 在设备认证成功后立即发送 pair_status "matched"
  并且 不发送任何 "waiting"（否则设备判为陈旧并自行重连）

场景: 第二终端抢占
  假设 会话已有终端 T1 且处于 paired
  当 终端 T2 以同一 device_sid 认证成功
  那么 relay 向 T1 发送 error 且 code 为 "KICKED"
  并且 T2 成为该会话唯一活动终端

场景: 设备离线时保留会话
  假设 设备与终端已配对
  当 设备连接断开
  那么 relay 向终端发送 error 且 code 为 "DEVICE_OFFLINE"
  并且 会话条目保留
  当 设备在 15 秒内重新认证
  那么 relay 立即发送 pair_status "matched"

场景: 角色不匹配的 proof 被拒
  假设 终端持有正确的 pass_hash
  当 终端以角色字符串 "device" 计算 proof
  那么 relay 返回 error 且 code 为 "AUTH_FAILED"

场景: 载荷不透明转发
  假设 设备与终端已配对
  当 设备发送 data 且 payload 含未知 zcode_type 与任意嵌套字段
  那么 relay 原样转发 payload
  并且 不修改 bridgeSessionId bridgeGeneration recoveryId
```

### 5.2 伪代码

```
on_message(conn, msg):
  case device_register_init:
      sid = new_unique_sid()
      registry.put(sid, {pass_hash: msg.pass_hash, device_conn: conn, terminal_conn: null})
      reply(conn, device_register_ack(sid))

  case auth_init:
      session = registry.get(msg.device_sid)      # 未知 sid -> AUTH_FAILED
      nonce = random_string()
      pend[conn] = {session, role: msg.role, nonce}
      reply(conn, auth_challenge(nonce))

  case auth_response:
      p = pend.pop(conn)                          # 无待验证挑战 -> AUTH_FAILED
      if not equal_ct(msg.proof, HMAC(p.session.pass_hash,
                                      p.nonce + "|" + p.role + "|" + sid)):
          reply(conn, error(AUTH_FAILED))
      attach(p.session, p.role, conn)             # 抢占旧终端 -> KICKED
      broadcast_pair_status(p.session)            # 必须向双方广播

  case pair_status_query:
      reply(conn, pair_status_ack(status_of(conn)))

  case data:
      if status_of(conn) != "matched": return     # 设备侧非 paired 也会静默丢弃
      peer = other_side(conn)
      if peer: send(peer, msg)                    # 逐字节原样，不解析 payload

status_of(conn) = "matched" if (s.device_conn and s.terminal_conn) else "waiting"

on_disconnect(conn):
  s = session_of(conn)
  if conn is s.device_conn:
      s.device_conn = null
      if s.terminal_conn: reply(s.terminal_conn, error(DEVICE_OFFLINE))
      # 保留会话等设备重连；pass_hash 不落盘，relay 重启即失效
  else:
      s.terminal_conn = null
```

## 6. 实现接口

```ts
type PairStatus = "waiting" | "matched";
type RelayErrorCode = "AUTH_FAILED" | "KICKED" | "DEVICE_OFFLINE" | "INTERNAL" | "WRONG_PARAM";
interface PeerMeta { platform: string; version: string; name: string }

type RelayMessage =
  | { type: "device_register_init"; device_mid: string; pass_hash: string; meta: PeerMeta; client_ts: number }
  | { type: "device_register_ack"; device_sid: string }
  | { type: "auth_init"; role: "device" | "terminal"; device_sid: string; meta: PeerMeta; client_ts: number }
  | { type: "auth_challenge"; nonce: string }
  | { type: "auth_response"; device_sid: string; proof: string; client_ts: number }
  | { type: "auth_ack"; pair_status: PairStatus }
  | { type: "pair_status_query"; device_sid: string; client_ts: number }
  | { type: "pair_status_ack"; pair_status: PairStatus }
  | { type: "data"; payload: unknown; client_ts?: number; server_ts?: number }
  | { type: "error"; code: RelayErrorCode; message?: string };

interface Session {
  deviceSid: string;
  passHash: string;                 // 仅内存，不持久化
  deviceConn: Conn | null;
  terminalConn: Conn | null;
}

interface SessionRegistry {
  put(sid: string, s: Session): void;
  get(sid: string): Session | undefined;
}

/** 抽象连接，屏蔽 ws 实现细节，便于测试注入 */
interface Conn {
  readonly isOpen: boolean;         // 异步校验期间判断对端是否已断开
  send(msg: RelayMessage): void;
  sendRaw(text: string): void;      // 逐字节转发 data
  close(): void;
}
```

`authenticator` 的接口在 Deno 上是异步的（Web Crypto 无同步 HMAC）：

```ts
// pass_hash 为标准 base64 带填充；proof 为 base64url 无填充
function calculateProof(passHash: string, nonce: string, role: AuthRole, sid: string): Promise<string>;
function verifyProof(
  passHash: string, nonce: string, role: AuthRole, sid: string, proof: string,
): Promise<boolean>;   // 内部是 subtle.verify：定长比较；非法 base64url 返回 false 而不抛错
```

实现须遵守的强约束（违反即客户端故障）：`payload` 不透明且不得增删字段；不得使用未知 `error.code`；`auth_ack` 与 `pair_status_ack` **必须**携带 `pair_status`（缺失会导致对端等 30 秒看门狗后重连）；单条 WS 消息上限 1048576 字节。

完整字段语义、编码细节（`pass_hash` 为标准 base64 带填充、`proof` 为 base64url 无填充、`dataBase64` 为标准 base64）、分片与校验和算法、状态机、定时器常数、边界情况见 `protocol.md`；SPA 提取与 patch 流程见 `patching.md`。
