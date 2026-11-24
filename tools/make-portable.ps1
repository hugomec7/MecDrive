# Monta o zip portátil a partir do build em src-tauri\target\release.
# A pasta data\ dentro do zip é o que faz o app guardar token e histórico ao lado do exe.
$ErrorActionPreference = 'Stop'
$root = Split-Path $PSScriptRoot -Parent
$rel = Join-Path $root 'src-tauri\target\release'
$ver = (Get-Content (Join-Path $root 'src-tauri\tauri.conf.json') -Raw -Encoding UTF8 | ConvertFrom-Json).version
$out = Join-Path $root 'dist'
$stage = Join-Path $out 'MecDrive'
if (Test-Path $stage) { Remove-Item $stage -Recurse -Force }
New-Item -ItemType Directory -Force "$stage\bin", "$stage\data" | Out-Null
Copy-Item "$rel\MecDrive.exe", "$rel\mecdrive-cli.exe" $stage
Copy-Item (Join-Path $root 'bin\rclone.exe') "$stage\bin"
Copy-Item (Join-Path $root 'THIRD-PARTY.md') $stage
Set-Content "$stage\data\LEIA-ME.txt" "Aqui ficam o token do Google (rclone.conf), o historico e a configuracao do MecDrive portatil. Nao compartilhe o rclone.conf." -Encoding utf8
$zip = Join-Path $out "MecDrive_${ver}_portable.zip"
if (Test-Path $zip) { Remove-Item $zip -Force }
Compress-Archive -Path $stage -DestinationPath $zip
Remove-Item $stage -Recurse -Force
"portátil em $zip"
