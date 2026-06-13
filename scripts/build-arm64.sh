#!/usr/bin/env bash
# 为 ARM64 fnOS 构建 FanControlServerApp。
# 在完整仓库根目录执行：chmod +x scripts/build-arm64.sh && ./scripts/build-arm64.sh
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
TARGET_ARCH="${TARGET_ARCH:-arm64}"
FNOS_PLATFORM="${FNOS_PLATFORM:-arm}"

step() {
    printf '\n==> %s\n' "$1"
}

require_cmd() {
    if ! command -v "$1" >/dev/null 2>&1; then
        echo "错误：缺少命令 $1" >&2
        exit 1
    fi
}

for cmd in npm go fnpack sed; do
    require_cmd "$cmd"
done

if [[ "$TARGET_ARCH" != "arm64" ]]; then
    echo "提示：该脚本面向 OES Plus，当前 TARGET_ARCH=${TARGET_ARCH}" >&2
fi

MANIFEST="${ROOT}/manifest"
if [[ ! -f "$MANIFEST" ]]; then
    echo "错误：未找到 ${MANIFEST}" >&2
    exit 1
fi

manifest_backup="$(mktemp)"
build_marker="$(mktemp)"
cp "$MANIFEST" "$manifest_backup"

cleanup() {
    cp "$manifest_backup" "$MANIFEST" 2>/dev/null || true
    rm -f "$manifest_backup" "$build_marker"
}
trap cleanup EXIT INT TERM

# fnpack 在打包时读取仓库根目录 manifest。仅构建期间切换平台，结束后自动恢复。
sed -i -E "s/^platform[[:space:]]*=.*/platform = ${FNOS_PLATFORM}/" "$MANIFEST"
if ! grep -qE "^platform[[:space:]]*=[[:space:]]*${FNOS_PLATFORM}[[:space:]]*$" "$MANIFEST"; then
    echo "错误：无法把 manifest platform 设置为 ${FNOS_PLATFORM}" >&2
    exit 1
fi

cd "$ROOT"

step "构建前端"
(
    cd "${ROOT}/frontend"
    npm install
    npm run build
)

if [[ ! -f "${ROOT}/backend/web/index.html" ]]; then
    echo "错误：未找到 backend/web/index.html" >&2
    exit 1
fi

mkdir -p "${ROOT}/app/target" "${ROOT}/app/server"

step "交叉编译后端 (linux/${TARGET_ARCH})"
(
    cd "${ROOT}/backend"
    go mod tidy
    GOOS=linux GOARCH="${TARGET_ARCH}" CGO_ENABLED=0 \
        go build -trimpath -ldflags '-s -w' \
        -o "${ROOT}/app/server/fancontrolserver" .
)

binary_arch="$(file "${ROOT}/app/server/fancontrolserver" 2>/dev/null || true)"
echo "${binary_arch}"
if [[ "$TARGET_ARCH" == "arm64" ]] && [[ "$binary_arch" != *"aarch64"* ]] && [[ "$binary_arch" != *"ARM aarch64"* ]]; then
    echo "警告：无法从 file 输出确认 ARM64 架构，请在安装前执行 readelf -h 检查" >&2
fi

step "打包 fnOS ARM 应用"
touch "$build_marker"
(
    cd "$ROOT"
    fnpack build
)

mkdir -p "${ROOT}/dist"
fpk_file="$(find "$ROOT" -maxdepth 1 -name '*.fpk' -type f -newer "$build_marker" | head -n 1)"
if [[ -z "$fpk_file" ]]; then
    echo "错误：未找到本次 fnpack 生成的 .fpk 文件" >&2
    exit 1
fi

output="${ROOT}/dist/$(basename "$fpk_file")"
mv -f "$fpk_file" "$output"

step "构建完成"
echo "二进制：${ROOT}/app/server/fancontrolserver"
echo "安装包：${output}"
echo "架构：linux/${TARGET_ARCH}，fnOS platform=${FNOS_PLATFORM}"
