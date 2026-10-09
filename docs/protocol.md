# Relay 协议规范

本文是自建 relay 的实现依据。来源：桌面端 bundle（device 侧）与厂商 SPA bundle（terminal 侧）双向逆向，两侧交叉验证。

**证据文件**（均为压缩 bundle，偏移为字符偏移）：

| 简称 | 路径 | 内容 |
|---|---|---|
| MAIN | `app.asar/out/main/index.js` | device 侧 `WebRemoteControlDeviceTransport`（类 `zi`） |
| RELAY | `app.asar/out/main/chunk-Q4A6QLKZ.js` | 帧封装、ack、重放缓冲 |
| SCHEMA | `app.asar/out/main/chunk-SPTKPKUJ.js` | `rpc-frame` schema、常数 |
| WEB | `zcode.z.ai/remote/v4/latest/assets/index-*.js` | terminal 侧 `WebRemoteControlTerminalTransport`（类 `X2t`） |
| WEBSHARED | `.../assets/src-*.js` | 共享 chunk：`sf`(relay 解析)、`goe`(链接参数)、close code 表 |

## 1. 传输层

- 单一 WebSocket 连接，**文本帧**，每条消息一个 JSON 对象。
- 连接 URL：`<relayWsUrl>` + `?mid=<deviceMid>`。
  - device 侧**总是**设置 `mid`，并附加请求头 `X-Device-ID: <deviceMid>`。
  - terminal 侧 `mid` 可选（浏览器无法设自定义头）。
  - relay 不应强制要求 `mid`。
- device 侧启用 `perMessageDeflate: true`。relay 可接受或拒绝该扩展。
- 接收端容忍二进制/ArrayBuffer/Blob 文本载荷，但文本是规范形式：**收到什么就转发什么**。
- **保序与消息边界**：`seq` 连续性与分片组装依赖逐连接 FIFO。relay 不得重排、合并或拆分消息。

## 2. 二维码 / 链接参数

device 构造链接（`buildWebRemoteControlExternalQrUrl`），baseUrl = `ZCODE_WEB_REMOTE_CONTROL_URL ?? ${origin}/remote/{v3|v4}`（appVersion ≥ 3.4.0 用 v4）：

| query 参数 | 映射字段 | 必需 | 说明 |
|---|---|---|---|
| `sid` | `deviceSid` | 是 | 缺失则 terminal 报 `invalid-mobile-connection` |
| `hash` | `passHash` | 是 | 配对共享密钥 |
| `t` | `timestamp` | 是 | **terminal 从不校验**，会话过期完全由 relay 负责 |
| `mid` | `deviceMid` | 否 | |
| `name` | `deviceName` | 否 | terminal 解析但不用于传输 |
| `app_version` | `appVersion` | 否 | 用作 terminal 的 `meta.version` |
| `theme` | theme | 否 | device 不会产出该参数 |

## 3. 密钥与证明

```
password  = randomBytes(24).toString("base64url")          # 32 字符，仅存在于 device
pass_hash = sha256(password).digest("base64")              # 标准 base64，含 '=' 填充
proof     = base64url_nopad( HMAC_SHA256( key = pass_hash 的 UTF-8 字节,
                                          message = `${nonce}|${role}|${deviceSid}` ) )
```

- `role` 是客户端在 `auth_init` 中声明的值：device 用 `"device"`，terminal 用 `"terminal"`。proof 与 role 绑定，故角色弄错必然校验失败。
- device 侧用 Node `crypto.createHmac`；terminal 侧用 `crypto.subtle.sign`。两者输出一致。
- **注意三个编码不要混淆**：`pass_hash` 是**标准 base64 带填充**；`proof` 是 **base64url 无填充**；`rpc-frame.dataBase64` 是**标准 base64**（见 §6）。

## 4. 消息目录

### 4.1 device → relay

| type | 字段 | 说明 |
|---|---|---|
| `device_register_init` | `device_mid`, `pass_hash`, `meta:{platform,version,name}`, `client_ts` | 仅在 `auth.mode==="register"` 时、于 `open` 后立即发送 |
| `auth_init` | `role:"device"`, `device_sid`, `meta`, `client_ts` | 注册模式下在 `device_register_ack` 之后发送；persisted 模式下在 `open` 后直接发送 |
| `auth_response` | `device_sid`, `proof`, `client_ts` | 应答 `auth_challenge` |
| `pair_status_query` | `device_sid`, `client_ts` | 心跳，仅在状态 ∈ {`paired`,`waiting_terminal`} 且已有 `device_sid` 时发送 |
| `data` | `payload`, `client_ts` | 由共享序列化器产出 |

### 4.2 terminal → relay

| type | 字段 | 说明 |
|---|---|---|
| `auth_init` | `role:"terminal"`, `device_sid`, `meta:{platform:"web",version:<appVersion??"web">,name:"mobile-browser"}`, `client_ts` | `open` 后立即发送 |
| `auth_response` | `device_sid`, `proof`, `client_ts` | proof 中 role 为 `"terminal"` |
| `pair_status_query` | `device_sid`, `client_ts` | 心跳，状态 ∈ {`paired`,`waiting`} |
| `data` | `payload`, `client_ts` | |

terminal 从不发送 `error`，也不接收 `device_register_ack`。

### 4.3 relay → device

| type | 字段 | 语义 |
|---|---|---|
| `device_register_ack` | `device_sid` | device 持久化 `{deviceSid, passHash}` 并立刻发 `auth_init` |
| `auth_challenge` | `nonce` | 若在 device 拿到 `device_sid` 之前到达，device 直接报错 |
| `auth_ack` | `pair_status` | **必须携带**，否则 device 卡住直到 30 秒看门狗触发重连 |
| `pair_status_ack` | `pair_status` | 与 `auth_ack` 处理完全一致 |
| `data` | `payload` | **仅在 device 状态为 `paired` 时被接受**，否则静默丢弃 |
| `error` | `code`, `message?` | 见 §5 |

### 4.4 relay → terminal

| type | 字段 | 语义 |
|---|---|---|
| `auth_challenge` | `nonce` | 触发 `auth_response` |
| `auth_ack` | `pair_status` | 触发看门狗 |
| `pair_status_ack` | `pair_status` | 应答心跳 |
| `data` | `payload` | **接收无状态门**；应用载荷逐条严格校验，非法即丢弃 |
| `error` | `code`, `message?` | |

## 5. 错误码与处理语义

线上形状：`{type:"error", code:<string>, message?:<string>}`。

| code | device 侧行为 | terminal 侧行为 |
|---|---|---|
| `KICKED` | 记 warn 后关闭 socket；close 处理走固定 1000ms 重连 | 进入 `kicked`，`intentionallyClosed=true`，不再重连，展示「被其他设备接管」 |
| `AUTH_FAILED` | persisted 且未重试过：清本地凭据 → 以**同一 pass_hash**、**新 device_sid** 立即重注册；否则进入 `error` 且不再重连 | `invalid-mobile-connection`，不再重连 |
| `DEVICE_OFFLINE` | —（device 不会收到） | 清定时器，应`desktopOfflineFailureTimer`（15s），立即重连；宽限期内未恢复则报 `desktop-disconnected` |
| `INTERNAL` | 处于 `paired`/`waiting_terminal`：**保留 socket**，回到 `waiting_terminal` 并重启心跳；否则进入可恢复错误并重连 | 处于 `paired` 或（已配对过且在 `waiting`）：保留 socket 回到 `waiting`；否则关闭并立即重连 |
| `WRONG_PARAM` | 处于 `paired`/`waiting_terminal`：只上抛错误，socket 与状态不变；否则进入 `error` 不重连 | `invalid-mobile-connection`，不重连 |
| 其他任意 code | 致命 `error`，不重连 | 致命 `relay-unavailable`，不重连 |

**实现约束**：只使用上述五个 code。两侧都把未知 code 当致命错误处理。

## 6. 分片与帧格式

### 6.1 `rpc-frame`

```
{
  zcode_type: "rpc-frame",
  bridgeSessionId: string,        // 1..256, ^[A-Za-z0-9._~-]+$
  bridgeGeneration?: int >= 0,    // undefined 时省略该字段
  recoveryId?: string,            // 1..256, 同上正则
  seq: int >= 1,                  // 物理（逐分片）序号
  messageSeq: int >= 1,           // 逻辑消息序号
  fragmentIndex: int >= 0,        // < fragmentCount
  fragmentCount: int >= 1,        // <= maxFragments 且 <= messageBytes
  messageBytes: int >= 1,         // 逻辑消息总字节数
  checksum: { algorithm: "crc32", value: /^[0-9a-f]{8}$/ },
  dataBase64: string              // 标准 base64（非 url），必须规范，长度 >= 4
}
```

严格 schema（`.strict()`）：**不得增删字段**。

`rpc-frame-ack`：

```
{ zcode_type: "rpc-frame-ack", bridgeSessionId, bridgeGeneration?, recoveryId?, ackMessageSeq: int >= 1 }
```

二者都作为 `{type:"data", payload:<frame>}` 的 `payload` 传输。

### 6.2 校验和

`crc32`，算法为 **CRC-32/ISO-HDLC**：init `0xFFFFFFFF`，反射，反向多项式 `0xEDB88320`，最终异或 `0xFFFFFFFF`，输出小写 8 位十六进制。

**计算对象是整条逻辑消息的字节**，算一次后复制进每个分片。

### 6.3 分片尺寸算法

1. 校验非空且 `messageBytes <= maxMessageBytes`。
2. 令 `l = 1`，循环：
   - 用 `dataBase64:""` 构造帧壳，按 **包含 `client_ts`/`server_ts` 取最大位数**的完整信封测量 UTF-8 字节数；
   - 二分求最大分片解码长度 `p`，使 `envelope + 4*ceil(p/3) <= maxPhysicalFrameBytes`；
   - `p < 1` ⇒ `envelopeTooLarge`；
   - `b = ceil(messageBytes/p)`；`b > maxFragments` ⇒ `fragmentLimitExceeded`；`b <= l` ⇒ 结束；否则 `l = b`。
3. 产出 `l` 个分片：第 `g` 片覆盖 `[g*p, min(messageBytes,(g+1)*p))`，`seq` 递增，`messageSeq` 恒定，`fragmentIndex = g`，`fragmentCount = l`，`checksum` 相同。每个分片的信封重新测量并必须 `<= maxPhysicalFrameBytes`。

`firstPhysicalSeq` / `messageSeq` 每个协议实例从 1 开始单调递增。

### 6.4 接收端组装

状态：`expectedPhysicalSeq`、`expectedMessageSeq`、`lastCompletedMessageSeq`、`active`（单条未完成消息）、已结算分片指纹表。

**分片指纹** = `JSON.stringify([bridgeSessionId, bridgeGeneration ?? null, recoveryId ?? null, seq, messageSeq, fragmentIndex, fragmentCount, messageBytes, checksum.algorithm, checksum.value, decodedByteLength, crc32(decodedChunk)])`

按序检查：身份不一致 ⇒ 非致命 `identityMismatch`；base64 非规范或超长 ⇒ 致命 `invalidBase64`；schema 失败 ⇒ `invalidMetadata`；`messageBytes` 超限 ⇒ `messageTooLarge`；`fragmentCount` 超限 ⇒ `fragmentLimitExceeded`；信封超限 ⇒ `envelopeTooLarge`；同 `seq` 已暂存且指纹相同 ⇒ `duplicate`（重发 ack），指纹不同 ⇒ `conflictingDuplicate`（致命）；`seq < expectedPhysicalSeq` ⇒ `duplicate`；`seq > expectedPhysicalSeq` ⇒ `physicalGap`（致命）；`messageSeq != expectedMessageSeq` ⇒ `messageGap`（致命）；`fragmentIndex` 不连续 ⇒ `fragmentGap`（致命）；元数据或校验和不一致 ⇒ `metadataMismatch`/`checksumMismatch`（致命）；组装完成时长度或 CRC 不符 ⇒ `lengthMismatch`/`checksumMismatch`（致命）。

组装超时：`active.firstSeenAt + 30000` ⇒ `remote.rpcFrame.assemblyTimeout`（致命）。

**结论**：relay 必须保证**同一逻辑消息的分片按序、无丢失、无重复**送达。

### 6.5 ack 与重放窗口

- 接收方每完成一条消息即排队 ack，仅保留**最大** `ackMessageSeq`（ack 会被合并，ack 数量少于消息数量是正常的）。
- 发送方 `processAck(e)`：`e <= lastAckedMessageSeq` 忽略；`e > highestFullySentMessageSeq` ⇒ 降级 `futureAck`；否则释放 `messageSeq <= e` 的所有批次。
- 重放触发：收到 `onSendReady`（即重新 `matched` 之后）时调用 `replayUnacknowledged()`，未确认批次以**原 `seq`/`messageSeq`** 重发。
- 背压：未确认字节 > 1 MiB 置 saturated，≤ 256 KiB 置 drained；上限 8 MiB。

### 6.6 降级（degraded）

降级对同一协议实例**永久有效**，客户端通过重新打开 workspace bridge（`bridge-degraded` + 新 `recoveryId` 的 `workspace-bridge-open`）恢复。

主要原因码：`ackGraceExceeded`(45s)、`replayGraceExceeded`(45s)、`replayBufferExceeded`(8MiB)、`assemblyTimeout`(30s)、`sendFailed`、`futureAck`、`manuallyDegraded`（收到超限 WS 消息时由 transport 标记），以及 §6.4 的各类组装故障。

### 6.7 协议栈分层（哪些对 relay 不透明）

```
WS 文本帧 = JSON {type:"data", payload:<P>, client_ts}
P (rpc-frame) = {zcode_type, bridgeSessionId, ..., dataBase64}
   dataBase64 解码 = 逻辑消息的一块分片
逻辑消息 = UTF-8 JSON「wire frame」（host↔desktop 层）：
   {wireVersion:3, kind:"complete"|"fragment", deliveryKind:"initial"|"online"|"recovery",
    logicalFrameId, logicalFrameOrdinal, topic, subscriptionId,
    frame | (fragmentIndex, fragmentCount, logicalBytes, checksum, dataBase64)}
```

**relay 只能看到前两层。**

## 7. 应用载荷目录（`data.payload.zcode_type`）

relay 必须**逐字节原样转发**。成员均为 `.strict()`，增删字段会被丢弃。

| zcode_type | 方向 | 关键字段 |
|---|---|---|
| `bootstrap-request` / `-response` | 终端→设备 / 设备→终端 | `requestId`；response 含 `result:{windowControlSessionId, workspaces, tasks, initialViewState?, mobileViewState?}` |
| `workspace-list-request` / `-response` | 双向 | `requestId`；response 含 `{workspaces, tasks?, activeWorkspaceKey?, activeTaskId?}` |
| `workspace-list-updated` | 设备→终端 | 同上（主动推送） |
| `workspace-bridge-open` | 终端→设备 | `requestId, bridgeSessionId, bridgeGeneration?, recoveryId?, workspaceKey, taskId?` |
| `workspace-bridge-ready` | 设备→终端 | `requestId, bridgeSessionId, bridgeGeneration?, recoveryId?, bridge:{kind:"local"\|"remote", workspacePath, initialTaskId?, workspaceIdentity?, remoteSessionId?}` |
| `workspace-bridge-error` | 设备→终端 | `requestId, bridgeSessionId?, reason, error` |
| `workspace-reconnect-request` / `-response` | 双向 | `requestId, workspaceKey`；response 含 `success` 或 `error` |
| `mobile-view-state-update` | 终端→设备 | `viewState:{activeWorkspaceKey?, activeTaskId?, updatedAt}, deviceInfo?` |
| `platform-request` / `-response` | 双向 | `requestId, method, args` / `result`\|`error` |
| `bridge-degraded` | 双向 | `bridgeSessionId, reason ∈ {rpc-transport-fault, rpc-frame-gap, buffer-overflow, buffer-timeout}` |
| `app-error` | 设备→终端 | `requestId?, reason, error` |
| `telemetry-report` | 终端→设备 | `event` |
| `mobile-diagnostic` | 终端→设备 | `event, timestamp, ...` |
| `rpc-frame` / `rpc-frame-ack` | 双向 | 见 §6 |

`reason` 枚举：`session-not-found`, `session-expired`, `session-conflict`, `workspace-closed`, `desktop-disconnected`, `invalid-mobile-connection`, `desktop-bootstrap-timeout`, `connection-recovery-timeout`, `relay-unavailable`, `unsupported-action`, `unexpected-error`。

## 8. 状态机

### 8.1 device

状态：`idle`, `connecting`, `registering`, `authenticating`, `waiting_terminal`, `paired`, `error`。

| 触发 | 迁移 | 副作用 |
|---|---|---|
| `start()` | → `connecting` | 重置标志，`connectAttempt++`，`socketGeneration++` |
| ws `open`（register 模式） | → `registering` | 发 `device_register_init` |
| ws `open`（persisted） | → `authenticating` | 发 `auth_init` |
| `device_register_ack` | → `authenticating` | 存 `device_sid`，发 `auth_init` |
| `auth_challenge` | 不变 | 发 `auth_response` |
| `auth_ack{pair_status:"waiting"}` | → `waiting_terminal` | 启动心跳 |
| `auth_ack` / `pair_status_ack` `matched` | → `paired` | `wasPaired=true`，记录 `lastPairedSocketGeneration`，启动心跳；若此前已配对过则触发 `onSendReady`（触发重放） |
| `paired` 收到第一个 `waiting` | 不变 | `staleWaitingCount=1`，启动 15 秒恢复定时器 |
| `paired` 收到第二个 `waiting` | 立即重连 | `reconnectAfterStaleWaiting(0)` |
| 心跳 ack 看门狗超时 | 重连 | 延迟 `[0, 2000]ms` |
| socket 关闭（非手动/非终止） | 不变 | 固定 1000ms 后重连 |

**关键**：`wasPaired` 不会被普通断线重连重置。因此 **relay 必须在设备重连认证成功后立即重发 `matched`**；否则首个 `waiting` 会被判为陈旧，触发 15 秒重连，第二个 `waiting` 直接重连。

### 8.2 terminal

状态：`idle`, `connecting`, `authenticating`, `waiting`, `paired`, `kicked`, `suspended`, `reconnecting`, `error`。

| 触发 | 迁移 | 副作用 |
|---|---|---|
| `start()` | → `connecting` | 重置标志 |
| ws `open` | → `authenticating` | 发 `auth_init` |
| `auth_challenge` | 不变 | 发 `auth_response` |
| `auth_ack{waiting}` 且从未配对 | → `waiting` | 停心跳，启动 30 秒 waiting 定时器（每次收到 `waiting` 都重置） |
| `matched` | → `paired` | 清全部定时器，`hadPairedSession=true`，启动心跳 |
| `paired` 收到 `waiting` | → `waiting` | `staleWaitingCount=0`（**与 device 不同，不递增**），清定时器，启动心跳，**不**启动 waiting 定时器 |
| waiting 定时器超时（30 秒） | → `error` | `invalid-mobile-connection` |
| `DEVICE_OFFLINE` | → `reconnecting` | 15 秒宽限 |
| 页面隐藏 / `freeze` / `pagehide` | → `suspended` | 保留 socket，清定时器 |
| 首次连接即断开（从未配对） | → `error` | `relay-unavailable`，**不重试** |
| 已配对后断开 | → `reconnecting` | 指数退避 |

重连退避：`min(10000, 500 * 2^attempt)` → 500, 1000, 2000, 4000, 8000, 10000, 10000…；`matched` 或 `recoverConnection` 时重置。

**relay 实现含义**：terminal 首次连接必须不能被断开（无重试）。另外，若 relay 持续应答心跳但永不重发 `matched`，terminal 会永久停留在 `waiting`（心跳会刷新两个定时器）——`staleWaitingRecoveryMs=1500` 在 terminal 侧是死代码（`scheduleStaleWaitingRecovery` 从未被调用）。

## 9. 定时器与常数（代码中的真实字面量）

| 名称 | 值 | 归属 |
|---|---|---|
| `heartbeatIntervalMs` | 10000 ms | 双方 |
| `heartbeatJitterMs` | 2000 ms → 实际心跳间隔 8000–12000 ms | 双方 |
| `heartbeatAckTimeoutMs` | 30000 ms | 双方 |
| `reconnectDelayMs` | 1000 ms（固定，无退避） | device |
| `reconnectJitterMs` | `[0, 2000]` ms | 双方（仅陈旧等待/心跳超时重连用） |
| stale-waiting 恢复 | 15000 ms | device |
| terminal 重连退避 | `min(10000, 500*2^attempt)` | terminal |
| `waitingTimeoutMs` | 30000 ms | terminal |
| `desktopOfflineGraceMs` | 15000 ms | terminal |
| `healthCheckTimeoutMs` | 3000 ms | terminal |
| `recoverConnection` / `waitForPaired` | 15000 ms | terminal |
| 出站载荷队列上限 / 丢弃定时器 | 50 条 / 5000 ms | device |
| `maxPhysicalFrameBytes` | 1048576 | 双方 |
| `maxMessageBytes` | 16777216 | 双方 |
| `maxFragments` | 64 | 双方 |
| `assemblyTimeoutMs` | 30000 ms | 双方 |
| `replayBufferMaxBytes` | 8388608 | 双方 |
| `replayBufferGraceMs` | 45000 ms | 双方 |
| 饱和高/低水位 | 1048576 / 262144 字节 | 双方 |
| `transportIdMaxChars` | 256 | 双方 |
| 链接 `t` 参数 | **无客户端校验** | — |

## 10. Relay 最小必需行为

1. 在 `relayWsUrl` 接受 WS 升级；读取 `?mid=` 与 `X-Device-ID`；**不要求** `mid`。
2. 容忍或拒绝 `permessage-deflate`；保持文本帧，一条 JSON 进、一条 JSON 出，字节不变。
3. 不得发送或转发超过 1048576 字节的 WS 消息（对端会降级桥接）。
4. 保持逐连接 FIFO，绝不合并或拆分消息。
5. `device_register_init` ⇒ 生成**唯一** `device_sid`，记录 `device_sid → pass_hash`，回 `device_register_ack`。重复注册（同一 `mid`）应产生新的 `device_sid`。
6. `auth_init`（任一角色）⇒ 回 `auth_challenge{nonce}`（新鲜、不可预测、非空）；校验
   `proof == base64url_nopad(HMAC_SHA256(key = pass_hash 的 UTF-8, msg = nonce + "|" + role + "|" + device_sid))`。
7. 认证成功 ⇒ 回 `auth_ack{pair_status}`：对端未连接则 `waiting`，已连接则 `matched`。**`pair_status` 字段必须存在。**
8. 认证失败（未知 `device_sid`、proof 错误、角色不符、会话过期）⇒ `error{code:"AUTH_FAILED"}`。
9. 只在同一 `device_sid` 的一个 device 与一个 terminal 之间、且**双方均 `matched` 之后**路由 `data`。device 在非 `paired` 状态会静默丢弃入站 `data`。
10. 对任何角色、任何状态下的 `pair_status_query` 都回 `pair_status_ack`。这是唯一的保活机制；缺失会导致双方在约 30 秒内重连。
11. `matched` 时**通知双方**；在任一侧（重）认证后发送**当前**状态。**设备重连后必须重发 `matched`**（否则 §8.1 的陈旧判定触发）。
12. 设备断开而终端仍在时：**保留会话**，向终端推 `error{code:"DEVICE_OFFLINE"}`；设备在终端 15 秒宽限内回归则重发 `matched`。
13. 新终端认证到已有终端的会话时，向**旧**终端发 `error{code:"KICKED"}`，新终端成为唯一活动终端。
14. 不解析、不校验、不转换、不重序列化任何 `payload`。必须**逐字节**转发，尤其 `bridgeSessionId`/`bridgeGeneration`/`recoveryId` 三元组与所有 `requestId`。
15. **可以**在 `{type:"data"}` 外层附加 `server_ts`（整型）——两侧都接受并忽略；**不得**在 `payload` 内增删字段，也不得改 `type`。
16. relay 拥有会话 TTL、`device_sid` 生成、`nonce` 生成。relay 永不见明文密码，只见过 `sha256(password)` 的 base64。

## 11. 边界情况

| 情况 | 客户端期望 relay 的行为 |
|---|---|
| 终端先接入，设备未到 | 回 `auth_ack{waiting}`；终端停心跳并启 30 秒 waiting 定时器（每次 `waiting` 重置）。超时即 `invalid-mobile-connection` 且不再重试 |
| 终端接入时设备已在等 | 回 `matched`（或先 `waiting` 再 `pair_status_ack matched`）并通知设备 |
| 多个终端 | 最新者胜；被顶掉的终端必须收到 `KICKED` |
| 设备在配对状态下重连 | device 保留 `wasPaired=true`；relay 必须立刻回 `matched`。设备会自行通过 `onSendReady → replayUnacknowledged()` 重放未确认批次，relay 不得丢弃或重排（它们保留原 `seq`/`messageSeq`） |
| relay 重启 / 会话丢失 | 已持久化凭据的设备收到 `AUTH_FAILED` → 清本地凭据 → 以同一 `pass_hash`、新 `device_sid` 重新注册；旧链接对浏览器失效 |
| 角色不匹配的 proof | 必须拒绝（`AUTH_FAILED`）。proof 与角色字符串绑定，诚实客户端不会误匹配 |
| 同 socket 重复 `auth_init` | **UNKNOWN**。客户端无去重；第二次挑战会触发第二次 `auth_response`，而重复的 `auth_ack` 幂等无害 |
| 超限入站消息 | 必须避免；双方都会降级桥接 |
| 信封头部可识别为 `data`、但整体不是合法 JSON | relay **原样转发**。§10.14 要求不解析 `payload`，故 relay 只扫信封头部的 `type`，不校验整体合法性；接收端本就会逐条严格校验并丢弃非法载荷，因此这类报文在下一跳被丢弃 |
| 乱序 / 重复分片 | 内容相同的重复 ⇒ 容忍（重 ack）；乱序 ⇒ 终端硬故障；冲突 ⇒ `conflictingDuplicate`/`checksumMismatch`。净效果是桥接永久降级，直到终端重新打开 |
| 缺失 ack | 发送方最多保留 8 MiB / 45 秒未确认数据，超限即降级 |
| relay 在配对前断开终端 | 终端**完全不重试**（`hadPairedSession===false`）。relay 不得丢弃首次连接的终端 socket |
| relay 在 `matched` 前发 `data` | device 静默丢弃（状态门）；terminal 无门会接受——不要依赖 |
| 配对状态下收到 `INTERNAL` | 双方都保留 socket 回到等待状态，relay 无需重新认证，继续应答真实状态 |
| relay 发出未知 `error.code` | 双方都致命且不重连。**绝不要发明新 code** |
| WS 关闭码 | 认证流**不读取**关闭码，只有 `hadPairedSession` 有意义 |
| Ping/Pong | 应用层未使用；`ws` 客户端自动 pong；relay 可自由 ping |

## 12. 第二套 relay 面（可选，本项目范围外）

SPA 中还存在一套**基于 token 的 HTTP + window-control WS** 客户端（`?remoteControlToken=` 触发），与本规范的认证流不同：

- `GET  ${relayOrigin}/api/remote-control/windows/bootstrap/${token}`
- `POST ${relayOrigin}/api/remote-control/platform/${token}`
- `POST ${relayOrigin}/api/remote-control/windows/${token}/workspace-bridge`，头 `X-ZCode-Mobile-Connection-Id`
- `POST ${relayOrigin}/api/remote-control/windows/${token}/mobile-view-state`
- `WS   ${relayOrigin}/ws/remote-control/window/${token}`，服务端首条必须发 `{type:"window-control-ready", windowControlSessionId, mobileConnectionId}`
- 关闭码：`4004` session-not-found，`4009` session-conflict，`4010` desktop-disconnected，`4011` session-expired，`4012` workspace-closed，`4013` invalid-mobile-connection
- 该 WS 使用**二进制 13 字节头 RPC 协议**（`type(1) | id(4 BE) | ack(4 BE) | length(4 BE) | body`），relay 必须透明管道转发二进制帧
- `windowControlSessionId` 等于设备的 `deviceSid`

桌面端 bundle 中**没有** `/api/remote-control/...` 的实现，但有对应的 device 侧处理器（`platform-request`→`platform-response` 等）。推测 relay 需把这些 HTTP 端点翻译成 device 侧的 app payload 并按 `requestId` 关联。

本项目只实现 §1–§11 的认证流。此节留作参考。

## 13. 已知未知项（实现时不要猜测）

1. `nonce` 的格式/长度/熵/单次使用策略——客户端只要求「存在的字符串」。
2. 真实 relay 是否在转发的 `data` 信封上附加 `server_ts`。
3. 会话 TTL 是否派生于链接的 `t` 参数——无客户端校验。
4. 设备对设备的冲突规则；生产中是否真的向设备发过 `KICKED`。
5. 认证 WS 是否使用 4004/4009/4010/4011/4012/4013 关闭码（这些码只被 window-control 流读取）。
6. relay 应发送的 `error.message` 文案（客户端只展示 `message ?? code`）。
7. `device_register_ack` 是否可携带额外字段（客户端只读 `device_sid`）。
8. relay 侧限额（最大会话数、速率），以及 `mid` 是否对路由有权威性（客户端每条路由消息都带 `device_sid`，故 `device_sid` 是唯一严格必需的键）。
9. §12 中 window-control 桥接 socket 的 `wsUrl` 形态与可达性。
10. §9 的定时器是否会被运行时覆盖——在抽取到的构建中，manager 构造两个 transport 时**未传**任何定时器选项，故 §9 的默认值即实际生效值。
11. 两侧序列化 `data` 信封时的**键序**。§6.7 把 `type` 写在最前，但那只是 schema 记法，不构成序列化顺序的证据（`verification.md` 未记录该项）。relay 的派发因此不依赖键序：`parseInbound` 的头部扫描不命中时会回退完整解析，键序异常只影响性能、不影响语义。若日后用 `echo-relay` 抓到真实报文的键序，应在此记录并同步更新实现注释。
