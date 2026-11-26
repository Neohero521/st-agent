# ST Agent 安装脚本（Windows PowerShell）
# 用法: .\install.ps1 -StDir "C:\SillyTavern" [-UserHandle "default-user"] [-WithBridge]
param(
    [Parameter(Mandatory = $true)][string]$StDir,
    [string]$UserHandle = "",
    [switch]$WithBridge
)

if (-not (Test-Path (Join-Path $StDir "server.js"))) {
    Write-Error "在 $StDir 下没找到 server.js，请确认是酒馆根目录"
    exit 1
}

$Here = Split-Path -Parent $MyInvocation.MyCommand.Path

# 1. 用户目录
$DataDir = Join-Path $StDir "data"
if (-not $UserHandle) {
    $candidates = Get-ChildItem $DataDir -Directory -ErrorAction SilentlyContinue |
        Where-Object { $_.Name -notmatch '^_|^\.' } | Select-Object -First 1
    if ($candidates) { $UserHandle = $candidates.Name }
}
if ($UserHandle -and (Test-Path (Join-Path $DataDir $UserHandle))) {
    $ExtDir = Join-Path $DataDir "$UserHandle\extensions"
} else {
    Write-Host "! 没找到用户数据目录，改为装到 public\scripts\extensions\third-party"
    $ExtDir = Join-Path $StDir "public\scripts\extensions\third-party"
}

# 2. 装扩展（这一步就够用了）
# 源：zip 版在 st-agent\ 子目录；如果脚本直接放在仓库根（根即扩展），就用本目录
$Src = Join-Path $Here "st-agent"
if (-not (Test-Path (Join-Path $Src "manifest.json"))) { $Src = $Here }
foreach ($f in @("manifest.json", "index.js", "tools.js", "style.css")) {
    if (-not (Test-Path (Join-Path $Src $f))) {
        Write-Error "找不到扩展文件 $f"
        exit 1
    }
}
New-Item -ItemType Directory -Force -Path $ExtDir | Out-Null
$ExtTarget = Join-Path $ExtDir "st-agent"
if (Test-Path $ExtTarget) { Remove-Item $ExtTarget -Recurse -Force }
New-Item -ItemType Directory -Force -Path $ExtTarget | Out-Null
foreach ($f in @("manifest.json", "index.js", "tools.js", "style.css")) {
    Copy-Item (Join-Path $Src $f) $ExtTarget -Force
}
Write-Host "OK 扩展 -> $ExtTarget"

# 3. 可选：磁盘桥接
if ($WithBridge) {
    $PluginDir = Join-Path $StDir "plugins"
    New-Item -ItemType Directory -Force -Path $PluginDir | Out-Null
    $BridgeTarget = Join-Path $PluginDir "st-agent-bridge"
    if (Test-Path $BridgeTarget) { Remove-Item $BridgeTarget -Recurse -Force }
    Copy-Item (Join-Path $Here "st-agent-bridge") $PluginDir -Recurse
    Write-Host "OK 桥接插件 -> $BridgeTarget"

    $Config = Join-Path $StDir "config.yaml"
    if (Test-Path $Config) {
        $content = Get-Content $Config -Raw
        if ($content -match 'enableServerPlugins:\s*false') {
            Copy-Item $Config "$Config.bak" -Force
            $content = $content -replace 'enableServerPlugins:\s*false', 'enableServerPlugins: true'
            Set-Content $Config $content -NoNewline
            Write-Host "OK 已在 config.yaml 开启 enableServerPlugins（原文件备份为 config.yaml.bak）"
        }
    }
}

Write-Host ""
Write-Host "完成。刷新酒馆页面，右下角出现「Agent」悬浮球。"
Write-Host "自检：F12 控制台执行 STAgent.tools.length（无桥接 33，有桥接 42）"
