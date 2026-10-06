' 双击以独立窗口（Electron）打开问渠学堂复习工具。
' 壳会自动拉起本地服务；关闭窗口时自动退出服务。
Set fso = CreateObject("Scripting.FileSystemObject")
root = fso.GetParentFolderName(WScript.ScriptFullName)
exe = root & "\node_modules\electron\dist\electron.exe"
If Not fso.FileExists(exe) Then
  MsgBox "还没有安装 Electron 依赖。" & vbCrLf & "请先在项目目录运行：npm install", vbExclamation, "问渠学堂复习工具"
  WScript.Quit
End If
Set sh = CreateObject("WScript.Shell")
sh.CurrentDirectory = root
sh.Run """" & exe & """ .", 0, False
