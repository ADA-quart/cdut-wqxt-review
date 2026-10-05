# 问渠学堂 PPT 整理复习系统 —— 启动 / 退出 / 升级 / 卸载（Windows）
#
# 用法：
#   powershell -ExecutionPolicy Bypass -File wqppt.ps1 start       # 一键启动（后台运行 + 打开浏览器）
#   powershell -ExecutionPolicy Bypass -File wqppt.ps1 stop        # 一键退出（含后台浏览器进程）
#   powershell -ExecutionPolicy Bypass -File wqppt.ps1 restart
#   powershell -ExecutionPolicy Bypass -File wqppt.ps1 status
#   powershell -ExecutionPolicy Bypass -File wqppt.ps1 update      # 一键升级（git pull + npm install）
#   powershell -ExecutionPolicy Bypass -File wqppt.ps1 uninstall   # 一键卸载（保留 downloads，除非加 -Purge）
#
# 也可以直接双击目录里的 启动.cmd / 退出.cmd / 升级.cmd / 卸载.cmd

param(
  [Parameter(Position = 0)]
  [ValidateSet('start', 'stop', 'restart', 'status', 'update', 'uninstall', 'help')]
  [string]$Action = 'start',

  # uninstall 时连 downloads/ 一起删除（PPT 原图 + 笔记 + 复习卡）
  [switch]$Purge,

  # start 时不自动打开浏览器
  [switch]$NoBrowser
)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location $root

$port = if ($env:PORT) { [int]$env:PORT } else { 3901 }
$url = "http://127.0.0.1:$port"

function Get-ServerPid {
  try {
    return (Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction Stop |
      Select-Object -First 1).OwningProcess
  } catch {
    return $null
  }
}

function Wait-ForServer([int]$Seconds = 30) {
  for ($i = 0; $i -lt ($Seconds * 2); $i++) {
    Start-Sleep -Milliseconds 500
    try {
      Invoke-WebRequest "$url/api/status" -UseBasicParsing -TimeoutSec 3 | Out-Null
      return $true
    } catch { }
  }
  return $false
}

function Start-Server {
  $existing = Get-ServerPid
  if ($existing) {
    Write-Host "服务已在运行（PID $existing）：$url" -ForegroundColor Yellow
  } else {
    New-Item -ItemType Directory -Force 'run' | Out-Null
    $p = Start-Process -FilePath 'node' -ArgumentList 'server/index.mjs' -WorkingDirectory $root `
      -WindowStyle Hidden `
      -RedirectStandardOutput "$root\run\server.log" `
      -RedirectStandardError "$root\run\server.err.log" -PassThru
    Write-Host "启动中…（PID $($p.Id)，日志 run\server.log）"
    if (-not (Wait-ForServer 40)) {
      Write-Host "启动超时，请看 run\server.err.log" -ForegroundColor Red
      exit 1
    }
    Write-Host "已就绪：$url" -ForegroundColor Green
  }
  if (-not $NoBrowser) { Start-Process $url | Out-Null }
}

function Stop-Server {
  $serverPid = Get-ServerPid
  if (-not $serverPid) {
    Write-Host '服务未在运行'
  } else {
    try { Invoke-RestMethod -Method Post "$url/api/system/shutdown" -TimeoutSec 8 | Out-Null } catch { }
    for ($i = 0; $i -lt 20; $i++) {
      Start-Sleep -Milliseconds 500
      if (-not (Get-ServerPid)) { break }
    }
    $still = Get-ServerPid
    if ($still) {
      Stop-Process -Id $still -Force -ErrorAction SilentlyContinue
      Write-Host "已强制结束服务进程 PID $still"
    } else {
      Write-Host '服务已退出' -ForegroundColor Green
    }
  }
  # 关掉本项目专用 profile 的 Edge（不影响日常浏览器）
  Get-CimInstance Win32_Process -Filter "Name='msedge.exe'" -ErrorAction SilentlyContinue |
    Where-Object { $_.CommandLine -like "*$root*edge-profile*" } |
    ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
}

function Update-App {
  if (-not (Test-Path (Join-Path $root '.git'))) {
    Write-Host '当前不是 git 仓库（可能是解压 ZIP 安装的），请到 GitHub 重新下载最新版' -ForegroundColor Yellow
    return
  }
  Write-Host '拉取最新代码…'
  git pull --ff-only
  if ($LASTEXITCODE -ne 0) { Write-Host 'git pull 失败（可能有本地改动冲突）' -ForegroundColor Red; return }
  Write-Host '同步依赖（npm install）…'
  npm install --no-audit --no-fund
  Write-Host '升级完成，重启程序后生效：wqppt.ps1 restart' -ForegroundColor Green
}

function Uninstall-App {
  Stop-Server
  if ($root -match '^[A-Za-z]:\\?$') { throw '拒绝在磁盘根目录执行卸载' }
  foreach ($name in @('.edge-profile', '.venv-p2t', 'node_modules', 'run')) {
    $target = Join-Path $root $name
    if (Test-Path -LiteralPath $target) {
      Remove-Item -LiteralPath $target -Recurse -Force
      Write-Host "已删除 $name"
    }
  }
  if ($Purge) {
    $dl = Join-Path $root 'downloads'
    if (Test-Path -LiteralPath $dl) {
      Remove-Item -LiteralPath $dl -Recurse -Force
      Write-Host '已删除 downloads/（PPT 原图 + 笔记 + 复习卡）'
    }
  } else {
    Write-Host '已保留 downloads/（PPT 原图 + 笔记）。要一起删：wqppt.ps1 uninstall -Purge' -ForegroundColor Yellow
  }
  Write-Host "卸载完成。现在可以手动删除这个文件夹：$root" -ForegroundColor Green
}

switch ($Action) {
  'start' { Start-Server }
  'stop' { Stop-Server }
  'restart' { Stop-Server; Start-Sleep -Seconds 1; Start-Server }
  'status' {
    $p = Get-ServerPid
    if ($p) { Write-Host "运行中：$url（PID $p）" -ForegroundColor Green } else { Write-Host '未运行' }
  }
  'update' { Update-App }
  'uninstall' { Uninstall-App }
  default {
    Write-Host '用法：wqppt.ps1 <start|stop|restart|status|update|uninstall> [-Purge] [-NoBrowser]'
  }
}
