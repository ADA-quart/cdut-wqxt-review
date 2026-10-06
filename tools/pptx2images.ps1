# PPT / PPTX → 每页图片（经由本机 PowerPoint COM，配合「导入自定义课件」使用）
# 用法：powershell -NoProfile -ExecutionPolicy Bypass -File tools/pptx2images.ps1 -PptPath <file> -OutDir <dir>
# 说明：只关闭本脚本打开的演示；若打开前 PowerPoint 里已有用户的文档，则不动整个应用，避免误关用户正在编辑的文件。
param(
  [Parameter(Mandatory = $true)][string]$PptPath,
  [Parameter(Mandatory = $true)][string]$OutDir,
  [int]$Width = 1920,
  [int]$Height = 1080
)
$ErrorActionPreference = 'Stop'
New-Item -ItemType Directory -Force $OutDir | Out-Null

$pres = $null
$ppt = $null
$hadOthers = $true
try {
  $ppt = New-Object -ComObject PowerPoint.Application
  $hadOthers = $ppt.Presentations.Count -gt 0
  # ReadOnly=$true, Untitled=$false, WithWindow=$false —— 不弹出窗口
  $pres = $ppt.Presentations.Open($PptPath, $true, $false, $false)
  # 导出全部幻灯片为 JPG（名字如「幻灯片1.JPG」，由调用方按数字自然排序）
  $pres.Export($OutDir, 'JPG', $Width, $Height)
} finally {
  if ($pres) { try { $pres.Close() } catch { } }
  if ($ppt) {
    try { if (-not $hadOthers) { $ppt.Quit() } } catch { }
    try { [System.Runtime.InteropServices.Marshal]::ReleaseComObject($ppt) | Out-Null } catch { }
  }
}
Write-Host 'OK'
