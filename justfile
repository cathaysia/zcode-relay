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

# 启动服务并自动在资源缺失时抓取；通过 Tailscale Serve 开启官方合规 HTTPS 反代（免自签证书告警）
up host="127.0.0.1" port="18899" assetsdir="vendor-assets" origin="" app="true":
    #!/usr/bin/env bash
    set -euo pipefail
    if [ ! -f "{{assetsdir}}/index.html" ]; then
        echo "==> 检测到资源目录 {{assetsdir}} 未抓取，开始自动抓取 SPA 静态资源..."
        node src/tools/fetch-assets.ts {{assetsdir}}
    fi

    DERIVED_ORIGIN="{{origin}}"
    USE_TS_SERVE=0

    if [ -z "${DERIVED_ORIGIN}" ]; then
        # 尝试使用 Tailscale MagicDNS 官方完整域名
        TS_STATUS="$(tailscale status --json 2>/dev/null || true)"
        TS_DNS="$(echo "${TS_STATUS}" | grep -m1 '"MagicDNSSuffix"' | sed -E 's/.*"MagicDNSSuffix": *"([^"]+)".*/\1/' || true)"
        TS_SELF="$(echo "${TS_STATUS}" | grep -m1 '"Self"' -A 5 | grep '"DNSName"' | sed -E 's/.*"DNSName": *"([^"]+)".*/\1/' | sed 's/\.$//' || true)"

        if [ -n "${TS_SELF}" ]; then
            DERIVED_ORIGIN="https://${TS_SELF}"
            USE_TS_SERVE=1
        elif [ -n "${TS_DNS}" ]; then
            DERIVED_ORIGIN="https://$(hostname -s | tr '[:upper:]' '[:lower:]').${TS_DNS}"
            USE_TS_SERVE=1
        else
            DERIVED_ORIGIN="http://{{host}}:{{port}}"
        fi
    fi

    # 如果走 Tailscale 域名，直接利用 tailscale serve 提供合规官方 HTTPS 反向代理（零证书警告）
    if [ "${USE_TS_SERVE}" = "1" ] && command -v tailscale >/dev/null 2>&1; then
        echo "==> 启动 Tailscale Serve 官方合规 HTTPS 反向代理: ${DERIVED_ORIGIN} -> 127.0.0.1:{{port}}"
        tailscale serve --bg {{port}} >/dev/null 2>&1 || true
    fi

    export ZCODE_RELAY_HOST="{{host}}"
    export ZCODE_RELAY_PORT="{{port}}"
    export ZCODE_ASSETS_DIR="{{assetsdir}}"
    export ZCODE_PUBLIC_ORIGIN="${DERIVED_ORIGIN}"

    RELAY_WS="${DERIVED_ORIGIN/http/ws}/ws"
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
        if [ "${USE_TS_SERVE}" = "1" ] && command -v tailscale >/dev/null 2>&1; then
            tailscale serve reset >/dev/null 2>&1 || true
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
