default:
    @just --list

install:
    npm install

# 跑全部测试
test:
    node --test "test/**/*.test.ts"

# 类型检查（Node 原生类型擦除不做类型检查，故单独一道）
lint:
    npx tsc --noEmit

# 启动 relay（默认仅监听 VPN 接口，地址由环境变量给出）
relay host="127.0.0.1" port="8899":
    ZCODE_RELAY_HOST={{host}} ZCODE_RELAY_PORT={{port}} node src/relay/main.ts

# 启动 echo relay：记录设备端实际发出的报文，用于核对 protocol.md
echo-relay host="127.0.0.1" port="8899":
    ZCODE_RELAY_HOST={{host}} ZCODE_RELAY_PORT={{port}} node src/tools/echo-relay.ts
