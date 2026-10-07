#!/bin/bash
# macOS：双击以独立窗口（Electron）打开清渠。
# Electron 运行库缺失时（npm install 没能下载二进制，国内网络常见）会用国内镜像自动修复。
cd "$(dirname "$0")" || exit 1

BIN="node_modules/electron/dist/Electron.app/Contents/MacOS/Electron"
MIRROR="https://npmmirror.com/mirrors/electron/"

if [ ! -x "$BIN" ]; then
  echo "Electron 运行库缺失（npm install 时二进制没有下载成功，国内网络常见）。"
  if [ ! -d "node_modules/electron" ]; then
    echo "还没有安装依赖，请先运行："
    echo "  export ELECTRON_MIRROR=$MIRROR"
    echo "  npm install"
    read -r -p "按回车退出…"
    exit 1
  fi
  echo "正在用国内镜像自动修复（约 100-200MB，需联网）…"
  if ! ELECTRON_MIRROR="${ELECTRON_MIRROR:-$MIRROR}" npm rebuild electron; then
    echo "自动修复失败，请手动运行：" >&2
    echo "  export ELECTRON_MIRROR=$MIRROR" >&2
    echo "  npm rebuild electron" >&2
    read -r -p "按回车退出…"
    exit 1
  fi
  if [ ! -x "$BIN" ]; then
    echo "修复后仍未找到 Electron 运行库，请手动运行：" >&2
    echo "  export ELECTRON_MIRROR=$MIRROR" >&2
    echo "  npm rebuild electron" >&2
    read -r -p "按回车退出…"
    exit 1
  fi
  echo "修复完成。"
fi

mkdir -p run
LOG="run/electron.log"
nohup "$BIN" . >"$LOG" 2>&1 &
PID=$!
sleep 1.5
if ! kill -0 "$PID" 2>/dev/null; then
  echo "Electron 启动失败，日志（run/electron.log）：" >&2
  tail -n 20 "$LOG" >&2 2>/dev/null || true
  read -r -p "按回车退出…"
  exit 1
fi
