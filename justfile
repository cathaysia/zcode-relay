default:
    @just --list

# 拉取依赖到 Deno 的全局缓存（无 node_modules、无构建步骤）
install:
    deno install

# 跑全部测试（Deno 内置测试运行器）
test:
    deno task --quiet test

# 静态检查：deno lint + 类型检查（Deno 只做类型擦除，运行期不做检查）
lint:
    deno task --quiet lint

# 格式化（deno fmt 是唯一格式口径）
fmt:
    deno task --quiet fmt

# 检查格式是否已就位（CI 用）
fmt-check:
    deno task --quiet fmt-check

# 启动 relay（默认仅监听 VPN 接口，地址由环境变量给出）
relay host="127.0.0.1" port="18899":
    ZCODE_RELAY_HOST={{host}} ZCODE_RELAY_PORT={{port}} deno task --quiet relay

# 启动 echo relay：记录设备端实际发出的报文，用于核对 protocol.md
echo-relay host="127.0.0.1" port="18899":
    ZCODE_RELAY_HOST={{host}} ZCODE_RELAY_PORT={{port}} deno task --quiet echo-relay

# 检查 SPA bundle 的 patch 锚点（漂移检测）
patch-check file:
    deno task --quiet patch-check {{file}}

# 对 SPA bundle 应用 patch
patch-apply input output:
    deno task --quiet patch-apply {{input}} {{output}}

# 抓取 SPA 资源（先加 --limit 小批量验证，再全量）
fetch-assets outdir *args:
    deno task --quiet fetch-assets {{outdir}} {{args}}

# 启动自托管 Relay 服务（SPA 资源缺失时自动抓取；若有 Tailscale 则自动配置官方合规 HTTPS 反代）
serve host="127.0.0.1" port="18899" assetsdir="vendor-assets" origin="":
    #!/usr/bin/env bash
    set -euo pipefail
    if [ ! -f "{{assetsdir}}/index.html" ]; then
        echo "==> 检测到资源目录 {{assetsdir}} 未就绪，自动抓取 SPA 静态资源..."
        deno task --quiet fetch-assets {{assetsdir}}
    fi

    DERIVED_ORIGIN="{{origin}}"
    USE_TS_SERVE=0

    if [ -z "${DERIVED_ORIGIN}" ]; then
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

    if [ "${USE_TS_SERVE}" = "1" ] && command -v tailscale >/dev/null 2>&1; then
        echo "==> 启动 Tailscale Serve 官方合规 HTTPS 反向代理: ${DERIVED_ORIGIN} -> 127.0.0.1:{{port}}"
        tailscale serve --bg {{port}} >/dev/null 2>&1 || true
    fi

    export ZCODE_RELAY_HOST="{{host}}"
    export ZCODE_RELAY_PORT="{{port}}"
    export ZCODE_ASSETS_DIR="{{assetsdir}}"
    export ZCODE_PUBLIC_ORIGIN="${DERIVED_ORIGIN}"

    cleanup() {
        if [ "${USE_TS_SERVE}" = "1" ] && command -v tailscale >/dev/null 2>&1; then
            tailscale serve reset >/dev/null 2>&1 || true
        fi
    }
    trap cleanup EXIT INT TERM

    exec deno task --quiet serve

# 启动 ZCode 桌面端客户端，并注入自托管 Relay 环境变量（支持跨机器指向远端 Relay）
zcode origin="":
    #!/usr/bin/env bash
    set -euo pipefail

    DERIVED_ORIGIN="{{origin}}"
    if [ -z "${DERIVED_ORIGIN}" ]; then
        TS_STATUS="$(tailscale status --json 2>/dev/null || true)"
        TS_SELF="$(echo "${TS_STATUS}" | grep -m1 '"Self"' -A 5 | grep '"DNSName"' | sed -E 's/.*"DNSName": *"([^"]+)".*/\1/' | sed 's/\.$//' || true)"
        if [ -n "${TS_SELF}" ]; then
            DERIVED_ORIGIN="https://${TS_SELF}"
        else
            DERIVED_ORIGIN="http://127.0.0.1:18899"
        fi
    fi

    RELAY_WS="${DERIVED_ORIGIN/http/ws}/ws"
    echo "==> 正在启动 ZCode 桌面端并注入环境:"
    echo "    ZCODE_WEB_REMOTE_CONTROL_RELAY_WS_URL=${RELAY_WS}"
    echo "    ZCODE_WEB_REMOTE_CONTROL_URL=${DERIVED_ORIGIN}/remote/v4"

    export ZCODE_WEB_REMOTE_CONTROL_RELAY_WS_URL="${RELAY_WS}"
    export ZCODE_WEB_REMOTE_CONTROL_URL="${DERIVED_ORIGIN}/remote/v4"

    if [ "$(uname)" = "Darwin" ]; then
        if [ -d "/Applications/ZCode.app" ]; then
            open -a "/Applications/ZCode.app"
        else
            echo "未找到 /Applications/ZCode.app"
            exit 1
        fi
    else
        if command -v /opt/ZCode/zcode >/dev/null 2>&1; then
            /opt/ZCode/zcode &
        elif command -v zcode >/dev/null 2>&1; then
            zcode &
        else
            echo "未找到 Linux zcode 可执行文件 (/opt/ZCode/zcode)"
            exit 1
        fi
    fi

# 一键启动合集：自动在后台启动 Relay 服务，并唤起本机 ZCode 桌面端
up host="127.0.0.1" port="18899" assetsdir="vendor-assets" origin="":
    #!/usr/bin/env bash
    set -euo pipefail
    (
        sleep 2
        just zcode origin="{{origin}}"
    ) &
    just serve host="{{host}}" port="{{port}}" assetsdir="{{assetsdir}}" origin="{{origin}}"

# 销毁下载的 SPA 资源与反代配置（清空 vendor-assets、清理 tailscale serve）
destroy assetsdir="vendor-assets":
    #!/usr/bin/env bash
    set -euo pipefail
    echo "==> 开始清理与销毁资源..."
    if command -v tailscale >/dev/null 2>&1; then
        echo "--> 重置 Tailscale Serve 配置..."
        tailscale serve reset >/dev/null 2>&1 || true
    fi
    if [ -d "{{assetsdir}}" ]; then
        echo "--> 删除静态资源目录 {{assetsdir}}..."
        rm -rf "{{assetsdir}}"
    fi
    echo "==> 销毁完成。"
