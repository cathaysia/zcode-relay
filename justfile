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

# 检查 SPA bundle 的 patch 锚点（漂移检测）
patch-check file:
    node src/tools/patch-spa-cli.ts check {{file}}

# 对 SPA bundle 应用 patch
patch-apply input output:
    node src/tools/patch-spa-cli.ts apply {{input}} {{output}}

# 抓取 SPA 资源（先加 --limit 小批量验证，再全量）
fetch-assets outdir *args:
    node src/tools/fetch-assets.ts {{outdir}} {{args}}

# 单端口部署：同端口提供 SPA 资源与 relay WebSocket
serve host="127.0.0.1" port="8899" assetsdir="vendor-assets" origin="":
    #!/usr/bin/env bash
    set -euo pipefail
    export ZCODE_RELAY_HOST={{host}}
    export ZCODE_RELAY_PORT={{port}}
    export ZCODE_ASSETS_DIR={{assetsdir}}
    export ZCODE_PUBLIC_ORIGIN={{origin}}
    exec node src/serve/main.ts
