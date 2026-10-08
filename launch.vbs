' Builds the renderer from the current source, then starts EasyWriter from this folder. No console window.
Set fso = CreateObject("Scripting.FileSystemObject")
Set sh = CreateObject("WScript.Shell")
dir = fso.GetParentFolderName(WScript.ScriptFullName)
sh.CurrentDirectory = dir
' Build failure falls through to launching the last good dist\renderer.js.
sh.Run "cmd /c npm run build", 0, True
sh.Run """" & dir & "\node_modules\electron\dist\electron.exe"" """ & dir & """", 1, False
