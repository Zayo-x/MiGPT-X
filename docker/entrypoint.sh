#!/bin/bash
# MiGPT-X 容器入口
#
# 容器里没有 systemd，所以原来由三个 systemd 服务负责的事情全在这里做：
#   1. 首次启动把配置模板拷进挂载卷（密钥永远不进镜像）
#   2. 把 TTS 微服务、引擎守护进程、控制台面板依次拉起来
#   3. 任何一个挂了就把整个容器停掉，交给 docker 的 restart 策略处理
#
# 进程模型：
#   entrypoint.sh ─┬─ python3 tts_server.py      端口 36594（仅本机）
#                  ├─ node supervisor.mjs        引擎的生命周期 + 日志落盘
#                  └─ node server.mjs            控制台面板，端口 36593
#
# 引擎本身由 supervisor.mjs 拉起，面板通过 control/request 文件控制它，
# 这条链路对应 panel/server.mjs 里的 MIGPT_MODE=local 分支。
set -euo pipefail

DATA_DIR="${MIGPT_DATA_DIR:-/data}"
ENGINE_DIR="${MIGPT_ENGINE_DIR:-/root/migpt-next-2}"
CODE_DIR="${MIGPT_CODE_DIR:-/root/migpt-panel}"     # 面板代码（镜像内，只读）
PANEL_DIR="${MIGPT_PANEL_DIR:-$DATA_DIR}"           # 面板的运行时数据（挂载卷）
PORT="${MIGPT_PORT:-36593}"
TTS_PORT="${MIGPT_TTS_PORT:-36594}"
TTS_VENV="${MIGPT_TTS_VENV:-/root/tts-venv}"        # 微软 edge-tts 所在的虚拟环境

log() { echo "[entrypoint] $*"; }

# ───────────────────────── 1. 数据卷初始化 ─────────────────────────
mkdir -p "$PANEL_DIR/tts" "$PANEL_DIR/control" "$DATA_DIR/backups"

if [ ! -f "$DATA_DIR/editable.json" ]; then
  if [ -f "$ENGINE_DIR/editable.example.json" ]; then
    cp "$ENGINE_DIR/editable.example.json" "$DATA_DIR/editable.json"
    log "📝 首次启动：已生成初始配置 $DATA_DIR/editable.json"
    log "   请打开面板填写「设备 ID / 账号 userId / passToken / API Key」后再保存"
  else
    log "❌ 找不到配置模板 editable.example.json，无法初始化"
    exit 1
  fi
fi

# 登录缓存由 @mi-gpt/miot 写在引擎目录下，路径不可配置，只能软链到卷上。
# 它是整体覆盖式写入、不会被 unlink，所以软链是安全的。
# （面板的 chat-mode 就不能用软链 —— 它会被 unlink，见 panel/server.mjs 的注释）
if [ ! -e "$ENGINE_DIR/.mi.json" ]; then
  : > "$DATA_DIR/.mi.json"
  ln -sf "$DATA_DIR/.mi.json" "$ENGINE_DIR/.mi.json"
fi

# ───────────────────────── 2. 统一环境变量 ─────────────────────────
# 面板和守护进程必须看到完全一致的路径，否则日志和重启请求会对不上。
export MIGPT_DATA_DIR="$DATA_DIR"
export MIGPT_ENGINE_DIR="$ENGINE_DIR"
export MIGPT_PANEL_DIR="$PANEL_DIR"
export MIGPT_TTS_DIR="$PANEL_DIR/tts"
export MIGPT_CMD_FILE="$PANEL_DIR/cmd.json"
export MIGPT_CHAT_MODE_FILE="$PANEL_DIR/chat-mode"
export MIGPT_LOG_FILE="$PANEL_DIR/engine.log"
export MIGPT_RUN_DIR="$PANEL_DIR/control"
export MIGPT_EDITABLE="$DATA_DIR/editable.json"
export MIGPT_TTS_API="http://127.0.0.1:$TTS_PORT"
export MIGPT_TTS_VENV="$TTS_VENV"
export MIGPT_MODE=local
export MIGPT_PORT="$PORT"
export MIGPT_TTS_PORT="$TTS_PORT"

log "数据目录   $DATA_DIR"
log "引擎目录   $ENGINE_DIR"
log "面板代码   $CODE_DIR"
log "进程模式   local（无 systemd，由 supervisor.mjs 守护引擎）"

# ───────────────────────── 3. 拉起三个进程 ─────────────────────────
PIDS=()

shutdown() {
  log "🛑 收到停止信号，正在退出…"
  for pid in "${PIDS[@]:-}"; do
    [ -n "${pid:-}" ] && kill "$pid" 2>/dev/null || true
  done
  wait 2>/dev/null || true
  exit 0
}
trap shutdown SIGTERM SIGINT

# TTS 微服务（同时提供小米 MiMo 与微软 edge-tts）
#
# 必须用虚拟环境里的 python 启动：tts_server.py 是进程内 import edge_tts 的，
# 而 edge-tts 只装在 /root/tts-venv 里，系统 python3 里没有这个模块。
# 宿主机上 systemd 也是这么写的（ExecStart=/root/tts-venv/bin/python3 ...）。
TTS_PY="$(command -v python3)"
if [ -x "$TTS_VENV/bin/python3" ]; then
  TTS_PY="$TTS_VENV/bin/python3"
fi
"$TTS_PY" "$CODE_DIR/tts_server.py" > "$PANEL_DIR/tts.log" 2>&1 &
PIDS+=($!)
log "🎙️  TTS 微服务已启动 (pid ${PIDS[-1]})，端口 $TTS_PORT，解释器 $TTS_PY"

# 引擎守护进程
node "$CODE_DIR/supervisor.mjs" > "$PANEL_DIR/supervisor.log" 2>&1 &
PIDS+=($!)
log "🐕  引擎守护进程已启动 (pid ${PIDS[-1]})"

# 控制台面板
node "$CODE_DIR/server.mjs" > "$PANEL_DIR/panel.log" 2>&1 &
PIDS+=($!)
log "🐱  控制台已启动 (pid ${PIDS[-1]})，端口 $PORT"

cat <<EOF

────────────────────────────────────────────────────────
  MiGPT-X 已就绪，浏览器打开：

      http://<这台机器的局域网IP>:$PORT

  首次使用请在面板里填写音箱的设备 ID、账号 userId、passToken
  以及大模型 API Key，保存后引擎会自动重启并接管音箱。

  音箱必须能访问到这台机器 —— 面板里「播报音色 → 音频地址前缀」
  要填成上面这个地址，否则音箱拉不到生成的语音。
────────────────────────────────────────────────────────

EOF

# ───────────────────────── 4. 看住子进程 ─────────────────────────
# 任何一个退出都停掉整个容器：docker 的 --restart 策略会重新拉起。
# 半死不活（比如 TTS 挂了但面板还在）比直接重启更难排查。
while true; do
  sleep 2
  for pid in "${PIDS[@]}"; do
    if ! kill -0 "$pid" 2>/dev/null; then
      log "⚠️ 进程 $pid 已退出，停止容器"
      shutdown
    fi
  done
done
