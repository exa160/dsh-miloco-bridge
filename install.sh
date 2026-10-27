#!/usr/bin/env bash
# dsh-miloco-bridge installer.
#
# Works in both situations:
#   * Miloco is already installed  -> install adapter, point it at DSH, write
#     connection + push token into the plugin overlay;
#   * Miloco is not installed      -> only install the plugin. The Web tab then
#     offers 「一键部署 Miloco」 or 「连接已有的 Miloco」.
#
# Usage:
#   ./install.sh [options]
#
# Options:
#   --profile <name>      DSH profile (default: $DSH_PROFILE or web)
#   --miloco-home <dir>   Miloco home (default: $MILOCO_HOME or ~/.miloco)
#   --dsh-origin <url>    DSH Web origin (default: $DSH_ORIGIN or http://127.0.0.1:3080)
#   --token <token>       Push/agent bearer token (default: Miloco's existing token or random)
#   --bundle <file.tgz>   Install from a packed bundle instead of link:this repo
#   --no-adapter          Do not install the Miloco agent_platform adapter
#   --no-connect          Only install the plugin; do not write connection/token
#   --check               Run offline checks only
#   -h, --help            Show this help
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROFILE="${DSH_PROFILE:-web}"
MILOCO_HOME="${MILOCO_HOME:-$HOME/.miloco}"
DSH_ORIGIN="${DSH_ORIGIN:-http://127.0.0.1:3080}"
PUSH_TOKEN="${MILOCO_PUSH_TOKEN:-}"
BUNDLE=""
ADAPTER=1
CONNECT=1
CHECK_ONLY=0

while [ $# -gt 0 ]; do
  case "$1" in
    --profile) PROFILE="${2:?}"; shift 2 ;;
    --miloco-home) MILOCO_HOME="${2:?}"; shift 2 ;;
    --dsh-origin) DSH_ORIGIN="${2:?}"; shift 2 ;;
    --token) PUSH_TOKEN="${2:?}"; shift 2 ;;
    --bundle) BUNDLE="${2:?}"; shift 2 ;;
    --no-adapter) ADAPTER=0; shift ;;
    --no-connect) CONNECT=0; shift ;;
    --check) CHECK_ONLY=1; shift ;;
    -h|--help) sed -n '2,30p' "$0"; exit 0 ;;
    *) echo "未知参数：$1" >&2; exit 2 ;;
  esac
done

DSH_HOME="${DSH_HOME:-$HOME/.dsh}"
PROFILE_DIR="$DSH_HOME/profiles/$PROFILE"
OVERLAY="${MILOCO_OVERLAY:-$DSH_HOME/miloco-plugin.json}"
MILOCO_CONFIG="$MILOCO_HOME/config.json"
DSH_ORIGIN="${DSH_ORIGIN%/}"

say() { printf '\033[36m▸\033[0m %s\n' "$*"; }
ok()  { printf '\033[32m✓\033[0m %s\n' "$*"; }
warn(){ printf '\033[33m!\033[0m %s\n' "$*"; }
die() { printf '\033[31m✗\033[0m %s\n' "$*" >&2; exit 1; }

node_json() {
  # node_json <file> <expr>  — read a JSON value, empty on failure.
  node -e '
    const fs = require("fs")
    try {
      const value = JSON.parse(fs.readFileSync(process.argv[1], "utf8"))
      const out = eval(process.argv[2])
      if (out !== undefined && out !== null) process.stdout.write(String(out))
    } catch {}
  ' "$1" "$2" 2>/dev/null || true
}

relative_home() {
  case "$1" in
    "$HOME"/*) printf '~/%s' "${1#"$HOME"/}" ;;
    *) printf '%s' "$1" ;;
  esac
}

# ---------------------------------------------------------------- offline check
run_checks() {
  say "离线自检"
  node --input-type=module -e "
    const index = await import('$HERE/lib/index.js')
    const cfg = index.normalizeConfig({})
    const tools = index.createMilocoTools({ client: index.createMilocoClient({}), readOnly: true })
    const { readdir } = await import('node:fs/promises')
    const { join } = await import('node:path')
    const dir = '$HERE/skills'
    const skills = (await readdir(dir, { withFileTypes: true })).filter(e => e.isDirectory())
    console.log('  package:', cfg.push.path, '| read tools:', tools.length, '| skills:', skills.length)
    if (tools.length < 30) throw new Error('只读工具数量异常')
    if (skills.length !== 18) throw new Error('技能数量不是 18')
  " || die "插件模块自检失败"
  if command -v python3 >/dev/null 2>&1; then
    python3 -c 'import pathlib, sys; compile(pathlib.Path(sys.argv[1]).read_text(encoding="utf-8"), sys.argv[1], "exec")' \
      "$HERE/adapter/dsh_adapter.py" || die "adapter 语法检查失败"
  fi
  ok "模块 / 工具 / 技能 / adapter 语法"
}

if [ "$CHECK_ONLY" = "1" ]; then
  run_checks
  if command -v curl >/dev/null 2>&1; then
    code=$(curl -s -o /dev/null -w '%{http_code}' -m 5 -X POST "$DSH_ORIGIN/miloco/webhook" 2>/dev/null || true)
    [ -n "$code" ] || code=000
    case "$code" in
      401|503|405) ok "webhook 已注册（未带令牌返回 $code，符合 fail-closed）" ;;
      000) warn "DSH 在 $DSH_ORIGIN 上没有响应（或插件未加载）" ;;
      *) warn "webhook 返回 $code，请检查配置" ;;
    esac
  fi
  exit 0
fi

# ---------------------------------------------------------------- plugin install
say "把 dsh-miloco-bridge 装进 DSH profile '$PROFILE'"
command -v dsh >/dev/null 2>&1 || die "找不到 dsh 命令"
if [ -n "$BUNDLE" ]; then
  [ -f "$BUNDLE" ] || die "bundle 不存在：$BUNDLE"
  BUNDLE="$(cd "$(dirname "$BUNDLE")" && pwd)/$(basename "$BUNDLE")"
  dsh plugin --profile "$PROFILE" add "file:$BUNDLE" >/dev/null
  ok "已安装 bundle：$BUNDLE"
else
  dsh plugin --profile "$PROFILE" add "link:$HERE" >/dev/null
  ok "已用 link 安装：$HERE"
fi
[ -d "$PROFILE_DIR" ] || die "profile 目录不存在：$PROFILE_DIR"

# ---------------------------------------------------------------- Miloco detection
MILOCO_INSTALLED=0
if [ -f "$MILOCO_CONFIG" ]; then MILOCO_INSTALLED=1; fi
MILOCO_CLI="${MILOCO_CLI:-$(command -v miloco-cli 2>/dev/null || true)}"
if [ -z "$MILOCO_CLI" ] && [ -f "$MILOCO_HOME/supervisord.conf" ]; then
  # 从 supervisord 的 command='.../python' 反推同目录下的 miloco-cli，
  # 这样源码迁移后即使 miloco-cli 不在 PATH 里也能找到。
  MILOCO_PY="$(sed -n "s/^command='\\([^']*\\)'.*/\\1/p" "$MILOCO_HOME/supervisord.conf" | head -1)"
  if [ -n "$MILOCO_PY" ] && [ -x "$(dirname "$MILOCO_PY")/miloco-cli" ]; then
    MILOCO_CLI="$(dirname "$MILOCO_PY")/miloco-cli"
  fi
fi
if [ -n "$MILOCO_CLI" ]; then
  # miloco-cli 内部会调用 supervisorctl；把同目录加入 PATH，避免
  # `config set` 在自动重启阶段因找不到 supervisorctl 而报错。
  export PATH="$(dirname "$MILOCO_CLI"):$PATH"
fi

if [ "$CONNECT" = "0" ]; then
  warn "按 --no-connect 跳过连接与 adapter 配置"
elif [ "$MILOCO_INSTALLED" = "0" ]; then
  warn "未检测到 $MILOCO_CONFIG —— Miloco 尚未安装"
  echo "  插件已安装，可以独立运行。"
  echo "  打开 DSH Web GUI：设置 → 插件 → Miloco，选择「一键部署 Miloco」或「连接已有的 Miloco」。"
else
  SERVER_URL="$(node_json "$MILOCO_CONFIG" 'value?.server?.url')"
  SERVER_TOKEN="$(node_json "$MILOCO_CONFIG" 'value?.server?.token')"
  AGENT_TOKEN="$(node_json "$MILOCO_CONFIG" 'value?.agent?.auth_bearer')"
  [ -n "$SERVER_URL" ] || SERVER_URL="http://127.0.0.1:1810"
  if [ -z "$PUSH_TOKEN" ]; then PUSH_TOKEN="$AGENT_TOKEN"; fi
  if [ -z "$PUSH_TOKEN" ]; then PUSH_TOKEN="$SERVER_TOKEN"; fi
  if [ -z "$PUSH_TOKEN" ]; then
    PUSH_TOKEN="$(openssl rand -base64 36 2>/dev/null | tr -d '\n=+/' | cut -c1-40 || true)"
  fi
  [ -n "$PUSH_TOKEN" ] || die "无法生成推送令牌，请用 --token 指定"

  say "写入运行时连接与推送令牌：$OVERLAY"
  MILOCO_OVERLAY="$OVERLAY" \
  MILOCO_BASE_URL="$SERVER_URL" \
  MILOCO_CONN_TOKEN="$SERVER_TOKEN" \
  MILOCO_PUSH_TOKEN="$PUSH_TOKEN" \
  node --input-type=module <<'NODE'
  import { mkdir, readFile, writeFile, rename, chmod } from 'node:fs/promises'
  import { dirname } from 'node:path'
  const file = process.env.MILOCO_OVERLAY
  let current = {}
  try { current = JSON.parse(await readFile(file, 'utf8')) } catch {}
  const next = {
    ...current,
    connection: {
      baseUrl: process.env.MILOCO_BASE_URL,
      token: process.env.MILOCO_CONN_TOKEN || '',
    },
    push: {
      ...(current.push || {}),
      token: process.env.MILOCO_PUSH_TOKEN,
      target: current.push?.target || { sessionId: '' },
      model: current.push?.model || { provider: '', model: '', reasoningEffort: '' },
      perception: current.push?.perception || { minLevel: 'all' },
    },
  }
  await mkdir(dirname(file), { recursive: true })
  const tmp = `${file}.${process.pid}.tmp`
  await writeFile(tmp, `${JSON.stringify(next, null, 2)}\n`, { mode: 0o600 })
  await rename(tmp, file)
  await chmod(file, 0o600)
NODE
  ok "overlay 已写入（权限 600）"

  if [ "$ADAPTER" = "1" ]; then
    say "安装 Miloco agent_platform adapter"
    mkdir -p "$MILOCO_HOME/agent_platform/dsh"
    cp "$HERE/adapter/dsh_adapter.py" "$MILOCO_HOME/agent_platform/dsh/adapter.py"
    WEBHOOK_URL="$DSH_ORIGIN/miloco/webhook" \
    AUTH_BEARER="$PUSH_TOKEN" \
    ADAPTER_CONFIG="$MILOCO_HOME/agent_platform/dsh/config.yaml" \
    node --input-type=module <<'NODE'
    import { writeFile, chmod } from 'node:fs/promises'
    const lines = [
      `webhook_url: ${JSON.stringify(process.env.WEBHOOK_URL)}`,
      `auth_bearer: ${JSON.stringify(process.env.AUTH_BEARER)}`,
      'include_home_profile: true',
      'home_profile_max_chars: 4000',
      '',
    ]
    await writeFile(process.env.ADAPTER_CONFIG, lines.join('\n'), { mode: 0o600 })
    await chmod(process.env.ADAPTER_CONFIG, 0o600)
NODE
    ok "adapter 与 config.yaml 已写入：$MILOCO_HOME/agent_platform/dsh/"

    if [ -n "$MILOCO_CLI" ]; then
      say "让 Miloco 使用 dsh adapter 并指向 DSH"
      if MILOCO_HOME="$MILOCO_HOME" "$MILOCO_CLI" config set agent.platform dsh \
        && MILOCO_HOME="$MILOCO_HOME" "$MILOCO_CLI" config set agent.webhook_url "$DSH_ORIGIN/miloco/webhook" \
        && MILOCO_HOME="$MILOCO_HOME" "$MILOCO_CLI" config set agent.auth_bearer "$PUSH_TOKEN"; then
        if systemctl --user cat miloco.service >/dev/null 2>&1; then
          systemctl --user restart miloco.service || warn "miloco.service 重启失败，请检查 systemctl --user status miloco.service"
        else
          MILOCO_HOME="$MILOCO_HOME" "$MILOCO_CLI" service restart || warn "Miloco 重启失败，请手动执行 miloco-cli service restart"
        fi
        ok "Miloco 已指向 DSH webhook"
      else
        warn "miloco-cli 配置失败，请手动执行："
        echo "  miloco-cli config set agent.platform dsh"
        echo "  miloco-cli config set agent.webhook_url \"$DSH_ORIGIN/miloco/webhook\""
        echo "  miloco-cli config set agent.auth_bearer \"$PUSH_TOKEN\""
        echo "  miloco-cli service restart"
      fi
    else
      warn "找不到 miloco-cli；adapter 已安装，但需要手动把 agent.platform 设为 dsh"
    fi
  fi
fi

# ---------------------------------------------------------------- checks
run_checks

if command -v curl >/dev/null 2>&1; then
  code=$(curl -s -o /dev/null -w '%{http_code}' -m 5 -X POST "$DSH_ORIGIN/miloco/webhook" 2>/dev/null || true)
  [ -n "$code" ] || code=000
  case "$code" in
    401|503|405) ok "webhook 已注册（未带令牌返回 $code）" ;;
    000) warn "DSH 未在 $DSH_ORIGIN 响应；重启 DSH 后再验证" ;;
    *) warn "webhook 返回 $code，请检查配置" ;;
  esac
fi

echo
ok "安装完成"
echo "  · 重启 DSH 让新插件生效（会中断当前会话）：systemctl --user restart dsh-web.service"
echo "  · 新建会话时选择「Miloco 家庭助手」预设；普通对话不会出现任何 miloco_* 工具。"
echo "  · 打开 设置 → 插件 → Miloco 查看概览、推送目标与运行模式。"
