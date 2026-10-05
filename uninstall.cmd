@echo off
chcp 65001 >nul
echo 将删除 .edge-profile / .venv-p2t / node_modules / run（保留 downloads）。
echo 如需连 PPT 与笔记一起删，请改用： powershell -ExecutionPolicy Bypass -File wqppt.ps1 uninstall -Purge
choice /c YN /m "继续卸载"
if errorlevel 2 exit /b 0
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0wqppt.ps1" uninstall
pause
