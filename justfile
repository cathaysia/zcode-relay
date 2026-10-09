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
relay host="127.0.0.1" port="18899":
    ZCODE_RELAY_HOST={{host}} ZCODE_RELAY_PORT={{port}} node src/relay/main.ts

# 启动 echo relay：记录设备端实际发出的报文，用于核对 protocol.md
echo-relay host="127.0.0.1" port="18899":
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

# 启动服务并自动在资源缺失时抓取；自动启动 Caddy HTTPS 自签名反代，在 macOS 下联动打开桌面端
up host="127.0.0.1" port="18899" https_port="8443" assetsdir="vendor-assets" origin="" app="true":
    #!/usr/bin/env bash
    set -euo pipefail
    if [ ! -f "{{assetsdir}}/index.html" ]; then
        echo "==> 检测到资源目录 {{assetsdir}} 未抓取，开始自动抓取 SPA 静态资源..."
        node src/tools/fetch-assets.ts {{assetsdir}}
    fi

    # 自动获取本机 IP（优先 Tailscale IP，其次局域网 IP 或 localhost）
    TS_IP="$(tailscale ip -4 2>/dev/null || true)"
    PUBLIC_HOST="${TS_IP:-127.0.0.1}"

    DERIVED_ORIGIN="{{origin}}"
    if [ -z "${DERIVED_ORIGIN}" ]; then
        DERIVED_ORIGIN="https://${PUBLIC_HOST}:{{https_port}}"
    fi

    # 动态生成 Caddyfile（若端口或 IP 变动）
    printf "{\n    admin off\n}\n\n%%s, https://localhost:{{https_port}} {\n    tls internal\n    reverse_proxy 127.0.0.1:{{port}}\n}\n" "${DERIVED_ORIGIN}" > Caddyfile

    # 启动 Caddy 作为后台反向代理
    if command -v mise >/dev/null 2>&1; then
        mise exec -- caddy stop >/dev/null 2>&1 || true
        mise exec -- caddy start >/dev/null 2>&1
        echo "==> Caddy HTTPS 反向代理已启动: ${DERIVED_ORIGIN} -> 127.0.0.1:{{port}}"
    elif command -v caddy >/dev/null 2>&1; then
        caddy stop >/dev/null 2>&1 || true
        caddy start >/dev/null 2>&1
        echo "==> Caddy HTTPS 反向代理已启动: ${DERIVED_ORIGIN} -> 127.0.0.1:{{port}}"
    fi

    export ZCODE_RELAY_HOST="{{host}}"
    export ZCODE_RELAY_PORT="{{port}}"
    export ZCODE_ASSETS_DIR="{{assetsdir}}"
    export ZCODE_PUBLIC_ORIGIN="${DERIVED_ORIGIN}"

    RELAY_WS="${DERIVED_ORIGIN/https/wss}/ws"
    if [ "{{app}}" = "true" ] && [ "$(uname)" = "Darwin" ] && [ -d "/Applications/ZCode.app" ]; then
        (
            sleep 1
            echo "==> 正在启动 macOS 桌面端 ZCode 并注入自托管 relay 环境..."
            export ZCODE_WEB_REMOTE_CONTROL_RELAY_WS_URL="${RELAY_WS}"
            export ZCODE_WEB_REMOTE_CONTROL_URL="${DERIVED_ORIGIN}/remote/v4"
            open -a "/Applications/ZCode.app"
        ) &
    fi

    cleanup() {
        if command -v mise >/dev/null 2>&1; then
            mise exec -- caddy stop >/dev/null 2>&1 || true
        elif command -v caddy >/dev/null 2>&1; then
            caddy stop >/dev/null 2>&1 || true
        fi
    }
    trap cleanup EXIT INT TERM

    exec node src/serve/main.ts

# 单端口部署：同端口提供 SPA 资源与 relay WebSocket（资源缺失时自动抓取）
serve host="127.0.0.1" port="18899" assetsdir="vendor-assets" origin="":
    #!/usr/bin/env bash
    set -euo pipefail
    if [ ! -f "{{assetsdir}}/index.html" ]; then
        echo "==> 检测到资源目录 {{assetsdir}} 未就绪，自动执行抓取..."
        node src/tools/fetch-assets.ts {{assetsdir}}
    fi
    export ZCODE_RELAY_HOST={{host}}
    export ZCODE_RELAY_PORT={{port}}
    export ZCODE_ASSETS_DIR={{assetsdir}}
    export ZCODE_PUBLIC_ORIGIN={{origin}}
    exec node src/serve/main.ts
