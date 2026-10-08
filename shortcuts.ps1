# Creates Desktop and Start Menu shortcuts that run EasyWriter from this folder via launch.vbs (rebuilds from source on each start).
$ErrorActionPreference = 'Stop'
$dir = $PSScriptRoot
$electron = Join-Path $dir 'node_modules\electron\dist\electron.exe'
if (-not (Test-Path $electron)) { throw 'Electron missing. Run npm install first.' }

$shell = New-Object -ComObject WScript.Shell
foreach ($folder in [Environment]::GetFolderPath('Desktop'), [Environment]::GetFolderPath('Programs')) {
  $lnk = $shell.CreateShortcut((Join-Path $folder 'EasyWriter.lnk'))
  $lnk.TargetPath = Join-Path $env:WINDIR 'System32\wscript.exe'
  $lnk.Arguments = '"' + (Join-Path $dir 'launch.vbs') + '"'
  $lnk.WorkingDirectory = $dir
  $lnk.IconLocation = "$(Join-Path $dir 'build\icon.ico'),0"
  $lnk.Description = 'Write and push Digital Academy Forum posts'
  $lnk.Save()
}
"Shortcuts point to $dir"
