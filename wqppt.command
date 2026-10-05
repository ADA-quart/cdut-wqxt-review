#!/bin/bash
# macOS 双击启动（Finder 里双击这个文件即可）
cd "$(dirname "$0")"
bash wqppt.sh start
echo
echo "可以关闭这个窗口了（服务在后台运行）"
sleep 2
