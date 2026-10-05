#!/usr/bin/env bash
# 问渠学堂 PPT 整理复习系统 —— 启动 / 退出 / 升级 / 卸载（macOS / Linux）
#
# 用法：
#   bash wqppt.sh start        # 一键启动（后台运行 + 打开浏览器）
#   bash wqppt.sh stop         # 一键退出（含后台浏览器进程）
#   bash wqppt.sh restart
#   bash wqppt.sh status
#   bash wqppt.sh update       # 一键升级（git pull + npm install）
#   bash wqppt.sh uninstall [--purge]   # 卸载（--purge 连 downloads 一起删）
#
# macOS 上可以直接双击 wqppt.command（启动）与 wqppt-stop.command（退出）

set -euo pipefail
cd "$(dirname "$0")"

PORT="${PORT:-3901}"
URL="http://127.0.0.1:${PORT}"
ROOT="$(pwd)"

server_pid() {
  if command -v lsof >/dev/null 2>&1; then
    lsof -nP -iTCP:"${PORT}" -sTCP:LISTEN -t 2>/dev/null | head -n1 || true
  else
    # 退路：用 curl 判断是否在跑，PID 未知
    curl -sf "${URL}/api/status" >/dev/null 2>&1 && echo "unknown" || true
  fi
}

open_browser() {
  if [ "$(uname -s)" = "Darwin" ]; then
    open "${URL}" >/dev/null 2>&1 || true
  elif command -v xdg-open >/dev/null 2>&1; then
    xdg-open "${URL}" >/dev/null 2>&1 || true
  fi
}

wait_for_server() {
  for _ in $(seq 1 60); do
    sleep 0.5
    curl -sf "${URL}/api/status" >/dev/null 2>&1 && return 0
  done
  return 1
}

start_server() {
  local pid
  pid="$(server_pid)"
  if [ -n "${pid}" ]; then
    echo "服务已在运行：${URL}（PID ${pid}）"
  else
    mkdir -p run
    nohup node server/index.mjs >>"${ROOT}/run/server.log" 2>&1 &
    echo "启动中…（PID $!，日志 run/server.log）"
    if ! wait_for_server; then
      echo "启动超时，请看 run/server.log" >&2
      exit 1
    fi
    echo "已就绪：${URL}"
  fi
  open_browser
}

stop_server() {
  if ! curl -sf "${URL}/api/status" >/dev/null 2>&1; then
    echo "服务未在运行"
    return
  fi
  curl -sf -X POST "${URL}/api/system/shutdown" >/dev/null 2>&1 || true
  for _ in $(seq 1 20); do
    sleep 0.5
    curl -sf "${URL}/api/status" >/dev/null 2>&1 || { echo "服务已退出"; return; }
  done
  local pid
  pid="$(server_pid)"
  if [ -n "${pid}" ] && [ "${pid}" != "unknown" ]; then
    kill -9 "${pid}" 2>/dev/null || true
    echo "已强制结束服务进程 PID ${pid}"
  fi
}

update_app() {
  if [ ! -d .git ]; then
    echo "当前不是 git 仓库（可能是解压 ZIP 安装的），请到 GitHub 重新下载最新版" >&2
    return 1
  fi
  echo "拉取最新代码…"
  git pull --ff-only
  echo "同步依赖（npm install）…"
  npm install --no-audit --no-fund
  echo "升级完成，重启程序后生效：bash wqppt.sh restart"
}

uninstall_app() {
  local purge="${1:-}"
  stop_server
  case "${ROOT}" in
    "/"|"${HOME}") echo "拒绝在 ${ROOT} 执行卸载" >&2; exit 1 ;;
  esac
  for name in .edge-profile .venv-p2t node_modules run; do
    if [ -e "${ROOT}/${name}" ]; then
      rm -rf "${ROOT:?}/${name}"
      echo "已删除 ${name}"
    fi
  done
  if [ "${purge}" = "--purge" ]; then
    rm -rf "${ROOT:?}/downloads"
    echo "已删除 downloads/（PPT 原图 + 笔记 + 复习卡）"
  else
    echo "已保留 downloads/（PPT 原图 + 笔记）。要一起删：bash wqppt.sh uninstall --purge"
  fi
  echo "卸载完成。现在可以手动删除这个文件夹：${ROOT}"
}

case "${1:-start}" in
  start) start_server ;;
  stop) stop_server ;;
  restart) stop_server; sleep 1; start_server ;;
  status)
    pid="$(server_pid)"
    if [ -n "${pid}" ]; then echo "运行中：${URL}（PID ${pid}）"; else echo "未运行"; fi
    ;;
  update) update_app ;;
  uninstall) uninstall_app "${2:-}" ;;
  *) echo "用法：bash wqppt.sh <start|stop|restart|status|update|uninstall [--purge]>" ;;
esac
