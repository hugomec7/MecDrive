# Baixa o rclone oficial (github.com/rclone/rclone) para bin\rclone.exe e confere o SHA256 publicado.
param([string]$Version = 'v1.76.0')
$ErrorActionPreference = 'Stop'
$root = Split-Path $PSScriptRoot -Parent
$bin = Join-Path $root 'bin'
$tmp = Join-Path $env:TEMP ("rclone-" + [guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Force $bin, $tmp | Out-Null
$name = "rclone-$Version-windows-amd64.zip"
$base = "https://github.com/rclone/rclone/releases/download/$Version"
Invoke-WebRequest "$base/$name" -OutFile "$tmp\$name"
Invoke-WebRequest "$base/SHA256SUMS" -OutFile "$tmp\SHA256SUMS"
$want = ((Get-Content "$tmp\SHA256SUMS" | Where-Object { $_ -match [regex]::Escape($name) }) -split '\s+')[0]
$got = (Get-FileHash "$tmp\$name" -Algorithm SHA256).Hash.ToLower()
if (-not $want -or $want -ne $got) { throw "SHA256 não confere: esperado $want, obtido $got" }
Expand-Archive "$tmp\$name" -DestinationPath $tmp -Force
Copy-Item (Get-ChildItem $tmp -Recurse -Filter rclone.exe | Select-Object -First 1).FullName (Join-Path $bin 'rclone.exe') -Force
Remove-Item $tmp -Recurse -Force
"rclone $Version em $bin\rclone.exe (SHA256 conferido)"
