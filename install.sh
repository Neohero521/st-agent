#!/usr/bin/env bash
# ST Agent 安装脚本（Linux / macOS / Termux）
# 用法: bash install.sh /path/to/SillyTavern [用户名] [--with-bridge]
set -euo pipefail

ST_DIR="${1:-}"
USER_HANDLE="${2:-}"
WITH_BRIDGE="no"
for arg in "$@"; do
    [ "$arg" = "--with-bridge" ] && WITH_BRIDGE="yes"
done

if [ -z "$ST_DIR" ] || [ ! -f "$ST_DIR/server.js" ]; then
    echo "用法: bash install.sh /path/to/SillyTavern [用户名] [--with-bridge]"
    echo "（$ST_DIR 下没找到 server.js，请确认这是酒馆根目录）"
    exit 1
fi

HERE="$(cd "$(dirname "$0")" && pwd)"

# 1. 找用户目录
if [ -z "$USER_HANDLE" ] || [ "$USER_HANDLE" = "--with-bridge" ]; then
    USER_HANDLE="$(ls -1 "$ST_DIR/data" 2>/dev/null | grep -v '^_' | grep -v '^\.' | head -1 || true)"
fi

if [ -n "$USER_HANDLE" ] && [ -d "$ST_DIR/data/$USER_HANDLE" ]; then
    EXT_DIR="$ST_DIR/data/$USER_HANDLE/extensions"
else
    echo "! 没找到用户数据目录，改为装到 public/scripts/extensions/third-party"
    EXT_DIR="$ST_DIR/public/scripts/extensions/third-party"
fi

# 2. 装扩展（这一步就够用了）
# 源：zip 版在 st-agent/ 子目录；如果脚本直接放在仓库根（根即扩展），就用本目录
SRC="$HERE/st-agent"
[ -f "$SRC/manifest.json" ] || SRC="$HERE"
if [ ! -f "$SRC/manifest.json" ] || [ ! -f "$SRC/index.js" ] || [ ! -f "$SRC/tools.js" ]; then
    echo "✗ 找不到扩展文件（manifest.json / index.js / tools.js）"
    exit 1
fi
mkdir -p "$EXT_DIR"
rm -rf "$EXT_DIR/st-agent"
mkdir -p "$EXT_DIR/st-agent"
cp "$SRC/manifest.json" "$SRC/index.js" "$SRC/tools.js" "$SRC/style.css" "$EXT_DIR/st-agent/"
echo "✓ 扩展 → $EXT_DIR/st-agent"

# 3. 可选：磁盘桥接
if [ "$WITH_BRIDGE" = "yes" ]; then
    mkdir -p "$ST_DIR/plugins"
    rm -rf "$ST_DIR/plugins/st-agent-bridge"
    cp -r "$HERE/st-agent-bridge" "$ST_DIR/plugins/"
    echo "✓ 桥接插件 → $ST_DIR/plugins/st-agent-bridge"
    CONFIG="$ST_DIR/config.yaml"
    if [ -f "$CONFIG" ] && grep -q '^enableServerPlugins: false' "$CONFIG"; then
        cp "$CONFIG" "$CONFIG.bak"
        sed -i 's/^enableServerPlugins: false/enableServerPlugins: true/' "$CONFIG"
        echo "✓ 已在 config.yaml 开启 enableServerPlugins（原文件备份为 config.yaml.bak）"
    fi
fi

echo ""
echo "完成。刷新酒馆页面，右下角出现「Agent」悬浮球。"
echo "自检：F12 控制台执行 STAgent.tools.length（无桥接 33，有桥接 42）"
