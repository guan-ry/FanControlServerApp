#Requires -Version 5.1
<#
  FanControlServer 一键构建（与 scripts/build.sh 等价）:
  1. 构建前端 (npm install & npm run build -> backend/web)
  2. 交叉编译后端 (linux/amd64 -> app/server/fancontrolserver)
  3. 打包 fnOS 应用 (fnpack build -> *.fpk)

  Usage (from repo root): .\scripts\build.ps1
#>

$ErrorActionPreference = "Stop"
$Root = Split-Path -Parent $PSScriptRoot

function Write-Step($msg)
{
    Write-Host "==> $msg" -ForegroundColor Cyan
}

Write-Step "Frontend (npm install & npm run build)"
Push-Location (Join-Path $Root "frontend")
try
{
    npm install
    if ($LASTEXITCODE -ne 0)
    {
        exit $LASTEXITCODE
    }
    npm run build
    if ($LASTEXITCODE -ne 0)
    {
        exit $LASTEXITCODE
    }
}
finally
{
    Pop-Location
}

# Verify frontend build output
$webDir = Join-Path $Root "backend\web"
$indexHtml = Join-Path $webDir "index.html"
if (-not (Test-Path -LiteralPath $indexHtml))
{
    Write-Error "Frontend build failed: $indexHtml not found. Please check npm run build output."
}

# 确保 target 目录存在（用于 Unix Socket）
New-Item -ItemType Directory -Force -Path (Join-Path $Root "app\target") | Out-Null

Write-Step "Cross-compile backend (GOOS=linux GOARCH=amd64) -> app\server\fancontrolserver"
$env:GOOS = "linux"
$env:GOARCH = "amd64"
$env:CGO_ENABLED = "0"
$serverDir = Join-Path $Root "app\server"
if (-not (Test-Path $serverDir))
{
    New-Item -ItemType Directory -Path $serverDir -Force | Out-Null
}
Push-Location (Join-Path $Root "backend")
try
{
    go mod tidy
    if ($LASTEXITCODE -ne 0)
    {
        exit $LASTEXITCODE
    }
    $manifestLine = Get-Content (Join-Path $Root "manifest") | Where-Object { $_ -match '^\s*version\s*=' } | Select-Object -First 1
    $appVersion = ($manifestLine -split '=', 2)[1].Trim()
    $ldflags = "-s -w -X fancontrolserver/internal/version.Version=$appVersion"
    $out = Join-Path $serverDir "fancontrolserver"
    go build -trimpath -ldflags $ldflags -o $out .
    if ($LASTEXITCODE -ne 0)
    {
        exit $LASTEXITCODE
    }
}
finally
{
    Remove-Item Env:\GOOS -ErrorAction SilentlyContinue
    Remove-Item Env:\GOARCH -ErrorAction SilentlyContinue
    Remove-Item Env:\CGO_ENABLED -ErrorAction SilentlyContinue
    Pop-Location
}

Write-Step "Pack fnOS application (fnpack build)"
Push-Location $Root
try
{
    fnpack build
    if ($LASTEXITCODE -ne 0)
    {
        exit $LASTEXITCODE
    }

    $distDir = Join-Path $Root "dist"
    if (-not (Test-Path $distDir))
    {
        New-Item -ItemType Directory -Path $distDir -Force | Out-Null
    }
    $fpkFile = Get-ChildItem -Path $Root -Filter "*.fpk" | Select-Object -First 1
    if ($fpkFile)
    {
        $destination = Join-Path $distDir $fpkFile.Name
        Move-Item -Path $fpkFile.FullName -Destination $destination -Force
        Write-Step "Moved package to $destination"
    }
    else
    {
        Write-Error "No .fpk file found after fnpack build."
    }
}
finally
{
    Pop-Location
}

Write-Host ""
Write-Host "Done. Output:" -ForegroundColor Green
Write-Host "  Binary:  app\server\fancontrolserver" -ForegroundColor Green
Write-Host "  Package: dist\*.fpk" -ForegroundColor Green