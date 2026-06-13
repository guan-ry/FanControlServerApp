#!/usr/bin/env bash
# 飞牛 fnOS 应用打包前构建
# 用法：
#   ./scripts/build.sh                 # 默认构建 x86/amd64 url 包
#   ARCH=arm64 ./scripts/build.sh      # 构建 ARM/aarch64 url 包
#   ARCH=amd64 UI_TYPE=iframe ./scripts/build.sh
#
# 支持的 ARCH：amd64, arm64
# 支持的 UI_TYPE：url, iframe

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
cd "$ROOT"

ARCH="${ARCH:-amd64}"
UI_TYPE="${UI_TYPE:-url}"

case "$ARCH" in
  amd64) PLATFORM="x86" ;;
  arm64) PLATFORM="arm" ;;
  *)
    echo "错误: 不支持的 ARCH=$ARCH，仅支持 amd64 或 arm64" >&2
    exit 1
    ;;
esac

case "$UI_TYPE" in
  url|iframe) ;;
  *)
    echo "错误: 不支持的 UI_TYPE=$UI_TYPE，仅支持 url 或 iframe" >&2
    exit 1
    ;;
esac

step() {
  printf '\n==> %s\n' "$1"
}

restore_files() {
  if [[ -f "${ROOT}/manifest.bak" ]]; then
    mv "${ROOT}/manifest.bak" "${ROOT}/manifest"
  fi
  if [[ -f "${ROOT}/app/ui/config.bak" ]]; then
    mv "${ROOT}/app/ui/config.bak" "${ROOT}/app/ui/config"
  fi
}
trap restore_files EXIT

step "构建前端"
( cd "${ROOT}/frontend" && npm install && npm run build )

if [[ ! -f "${ROOT}/backend/web/index.html" ]]; then
  echo "错误: 未找到 backend/web/index.html" >&2
  exit 1
fi

# 确保 target 目录存在（用于 Unix Socket）
mkdir -p "${ROOT}/app/target"

step "交叉编译后端 (linux/${ARCH}) -> app/server/fancontrolserver"
mkdir -p "${ROOT}/app/server"
( cd "${ROOT}/backend" && go mod tidy && GOOS=linux GOARCH="${ARCH}" CGO_ENABLED=0 go build -trimpath -ldflags '-s -w' -o "${ROOT}/app/server/fancontrolserver" . )

step "设置 fnOS manifest platform=${PLATFORM}, UI type=${UI_TYPE}"
cp "${ROOT}/manifest" "${ROOT}/manifest.bak"
sed -E -i 's/^(platform[[:space:]]*=[[:space:]]*).*/\1'"${PLATFORM}"'/' "${ROOT}/manifest"

cp "${ROOT}/app/ui/config" "${ROOT}/app/ui/config.bak"
sed -E -i 's/"type"[[:space:]]*:[[:space:]]*"(url|iframe)"/"type": "'"${UI_TYPE}"'"/' "${ROOT}/app/ui/config"

step "打包 fnOS 应用 (fnpack build)"
rm -f "${ROOT}"/*.fpk
( cd "${ROOT}" && fnpack build )

mkdir -p "${ROOT}/dist"
fpk_file=$(find "${ROOT}" -maxdepth 1 -name "*.fpk" -type f | head -1)
if [[ -n "$fpk_file" ]]; then
  base="${fpk_file##*/}"
  base="${base%.fpk}"
  out="${ROOT}/dist/${base}-${PLATFORM}-${UI_TYPE}.fpk"
  mv "$fpk_file" "$out"
  echo "移动安装包到 $out"
else
  echo "错误: 未找到生成的 .fpk 文件" >&2
  exit 1
fi

echo ""
echo "完成。产物:"
echo "  架构:    ${PLATFORM} (${ARCH})"
echo "  UI:      ${UI_TYPE}"
echo "  二进制:  app/server/fancontrolserver"
echo "  安装包:  ${out}"
