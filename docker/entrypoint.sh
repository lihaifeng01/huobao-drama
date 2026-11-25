#!/bin/sh
# 容器入口：workspace 模板 copy-once 到数据卷（与桌面版 userData 同一语义），然后启动后端
set -e

if [ -z "${HUOBAO_VERSION:-}" ]; then
  HUOBAO_VERSION=$(node -e "const v = require('/app/version.json').version; if (typeof v !== 'string' || !v.trim()) throw new Error('Invalid application version'); process.stdout.write(v)")
  export HUOBAO_VERSION
fi

if [ ! -e /app/data/workspace/.template-version ]; then
  mkdir -p /app/data/workspace
  cp -a /app/workspace-template/. /app/data/workspace/
  touch /app/data/workspace/.template-version
fi

cd /app/backend
exec node_modules/.bin/tsx src/index.ts
