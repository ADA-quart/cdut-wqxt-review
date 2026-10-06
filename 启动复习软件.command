#!/bin/bash
# macOS：双击以独立窗口（Electron）打开问渠学堂复习工具
cd "$(dirname "$0")" || exit 1
if [ ! -x "node_modules/.bin/electron" ]; then
  echo "还没有安装 Electron 依赖，请先运行：npm install"
  read -r -p "按回车退出…"
  exit 1
fi
nohup node_modules/.bin/electron . >/dev/null 2>&1 &
