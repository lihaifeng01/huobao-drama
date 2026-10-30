#!/usr/bin/env bash
# 打包 Docker 镜像（默认 linux/amd64、国内镜像源、导出 tar.gz）
#
# 用法：
#   scripts/docker-build.sh [版本号]       版本号缺省取 desktop/package.json 的 version
#
# 环境变量：
#   IMAGE_NAME  镜像名            默认 lihaifeng1995/huobao-drama
#   PLATFORM    目标平台          默认 linux/amd64（多平台如 linux/amd64,linux/arm64 仅支持 PUSH=1）
#   CN_MIRROR   国内镜像源 1/0    默认 1
#   SAVE        导出 tar.gz 1/0   默认 1（输出到 dist/docker/）
#   PUSH        推送到仓库 1/0    默认 0
#   BASE_REGISTRY / NPM_REGISTRY / APT_MIRROR / SQLITE_BINARY_HOST / NODE_DISTURL  覆盖国内源
#               BASE_REGISTRY 未指定时依次尝试多个加速站（某个 502/超时则自动换下一个）
set -euo pipefail

cd "$(dirname "$0")/.."

VERSION="${1:-$(node -p "require('./desktop/package.json').version")}"
IMAGE_NAME="${IMAGE_NAME:-lihaifeng1995/huobao-drama}"
PLATFORM="${PLATFORM:-linux/amd64}"
CN_MIRROR="${CN_MIRROR:-1}"
SAVE="${SAVE:-1}"
PUSH="${PUSH:-0}"

args=(--platform "$PLATFORM" --build-arg "HUOBAO_VERSION=$VERSION" -t "$IMAGE_NAME:$VERSION" -t "$IMAGE_NAME:latest")

base_registries=("")
if [ "$CN_MIRROR" = "1" ]; then
  if [ -n "${BASE_REGISTRY:-}" ]; then
    base_registries=("$BASE_REGISTRY")
  else
    base_registries=(docker.m.daocloud.io/library/ docker.1ms.run/library/ dockerproxy.net/library/ hub.rat.dev/library/)
  fi
  args+=(
    --build-arg "NPM_REGISTRY=${NPM_REGISTRY:-https://registry.npmmirror.com}"
    --build-arg "APT_MIRROR=${APT_MIRROR:-mirrors.ustc.edu.cn}"
    --build-arg "SQLITE_BINARY_HOST=${SQLITE_BINARY_HOST:-https://registry.npmmirror.com/-/binary/better-sqlite3}"
    --build-arg "NODE_DISTURL=${NODE_DISTURL:-https://npmmirror.com/mirrors/node}"
  )
fi

if [ "$PUSH" = "1" ]; then
  args+=(--push)
else
  args+=(--load)
fi

echo "==> 构建 $IMAGE_NAME:$VERSION ($PLATFORM, CN_MIRROR=$CN_MIRROR)"
built=0
for reg in "${base_registries[@]}"; do
  echo "==> 基础镜像源：${reg:-官方 Docker Hub}"
  if docker buildx build "${args[@]}" --build-arg "BASE_REGISTRY=$reg" .; then
    built=1
    break
  fi
  echo "==> 该源失败，尝试下一个" >&2
done
[ "$built" = "1" ] || { echo "构建失败：所有基础镜像源均不可用" >&2; exit 1; }

if [ "$SAVE" = "1" ] && [ "$PUSH" != "1" ]; then
  out="dist/docker/$(basename "$IMAGE_NAME")-$VERSION-${PLATFORM//\//-}.tar.gz"
  mkdir -p dist/docker
  echo "==> 导出 $out"
  docker save "$IMAGE_NAME:$VERSION" | gzip > "$out"
  ls -lh "$out"
fi

echo "==> 完成：$IMAGE_NAME:$VERSION"
