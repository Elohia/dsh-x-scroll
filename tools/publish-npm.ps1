<#
publish-npm.ps1 —— 用一次性 token 发布 dsh-x-scroll，不把 token 落到任何长期文件里。
用法:
  powershell -File tools\publish-npm.ps1 -Token 'npm_xxx'
  powershell -File tools\publish-npm.ps1            # 用环境变量 NPM_PUBLISH_TOKEN
说明:
  · 临时写一个不含 proxy 的 .npmrc（registry.npmjs.org），发布完立刻删除
  · 先 whoami 验 token；401 就直接退出，不会把包发歪
  · 本机实测：走代理 publish 会 ECONNRESET，所以这里强制 --noproxy
#>
param([string]$Token = $env:NPM_PUBLISH_TOKEN)

$ErrorActionPreference = 'Stop'
$repo = Split-Path -Parent $PSScriptRoot
$tmpNpmrc = Join-Path $env:TEMP ("dsh-x-scroll-publish-" + [guid]::NewGuid().ToString('N').Substring(0,8) + ".npmrc")

if (-not $Token) { Write-Error "没有 token：传 -Token 或设 NPM_PUBLISH_TOKEN"; exit 2 }
if ($Token -notmatch '^npm_[A-Za-z0-9]{30,}$') { Write-Error "token 格式不像 npm token（应 npm_ 开头）"; exit 2 }

try {
  Set-Content -Path $tmpNpmrc -Encoding utf8 -Value @(
    "registry=https://registry.npmjs.org/"
    "//registry.npmjs.org/:_authToken=$Token"
    "cache=F:/npm-cache"
  )

  Write-Host "[1/3] 验 token..."
  $who = & npm whoami --registry=https://registry.npmjs.org/ --userconfig=$tmpNpmrc 2>&1
  if ($LASTEXITCODE -ne 0) { Write-Host $who; Write-Error "token 无效（whoami 401），先到 npmjs.com/settings/<user>/tokens 重新生成"; exit 3 }
  Write-Host "      ok: $who"

  Write-Host "[2/3] 打包预检..."
  Push-Location $repo
  & npm publish --dry-run --registry=https://registry.npmjs.org/ --access public --userconfig=$tmpNpmrc 2>&1 | Select-Object -Last 3

  Write-Host "[3/3] 发布..."
  & npm publish --registry=https://registry.npmjs.org/ --access public --userconfig=$tmpNpmrc 2>&1 | Select-Object -Last 6
  $code = $LASTEXITCODE
  Pop-Location
  exit $code
} finally {
  Remove-Item $tmpNpmrc -Force -ErrorAction SilentlyContinue
  Write-Host "（临时 .npmrc 已删除）"
}
