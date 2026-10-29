# 国内构建参数（默认值为官方源；国内网络见 README / docker build 示例）：
#   BASE_REGISTRY  Docker Hub 镜像前缀，如 docker.m.daocloud.io/library/
#   NPM_REGISTRY   npm 源，如 https://registry.npmmirror.com
#   APT_MIRROR     Debian 源主机，如 mirrors.ustc.edu.cn
#   SQLITE_BINARY_HOST / NODE_DISTURL  better-sqlite3 预编译包与 node 头文件镜像
ARG BASE_REGISTRY=""
ARG NPM_REGISTRY=https://registry.npmjs.org
ARG APT_MIRROR=""
ARG SQLITE_BINARY_HOST=""
ARG NODE_DISTURL=""

# ===== 前端构建：Nuxt generate 产出静态站点 =====
FROM ${BASE_REGISTRY}node:22-bookworm-slim AS frontend-build
ARG NPM_REGISTRY
WORKDIR /build/frontend
COPY frontend/package.json frontend/package-lock.json ./
# lockfile 的 resolved 可能指向带鉴权的私有 registry（开发者本机 .npmrc），镜像内会 401。
# 构建期删除 resolved 字段（integrity 校验不受影响），让 npm 统一走公共 registry
RUN node -e "const fs=require('fs');const l=JSON.parse(fs.readFileSync('package-lock.json'));for(const p of Object.values(l.packages||{}))delete p.resolved;fs.writeFileSync('package-lock.json',JSON.stringify(l,null,2))" \
  && npm ci --no-audit --no-fund --registry=${NPM_REGISTRY}
COPY frontend/ ./
RUN npm run generate

# ===== 后端构建：安装依赖（含原生模块编译） =====
# better-sqlite3 使用预编译包，无需编译工具链，故用 slim 基础镜像（体积小得多）
FROM ${BASE_REGISTRY}node:22-bookworm-slim AS backend-build
ARG NPM_REGISTRY
ARG SQLITE_BINARY_HOST
ARG NODE_DISTURL
WORKDIR /build/backend
COPY backend/package.json backend/package-lock.json ./
RUN node -e "const fs=require('fs');const l=JSON.parse(fs.readFileSync('package-lock.json'));for(const p of Object.values(l.packages||{}))delete p.resolved;fs.writeFileSync('package-lock.json',JSON.stringify(l,null,2))" \
  && npm ci --ignore-scripts --no-audit --no-fund --registry=${NPM_REGISTRY}
# 跳过 ffmpeg-static 等从 GitHub 下载二进制的 postinstall（运行时用系统 ffmpeg），仅单独构建 better-sqlite3
RUN npm_config_better_sqlite3_binary_host=${SQLITE_BINARY_HOST} npm_config_disturl=${NODE_DISTURL} \
  npm rebuild better-sqlite3
COPY backend/ ./
# 运行时与既有服务器部署一致走 tsx（源码存在 bundler 风格无扩展名 import，tsc 产物 node 直跑不可行）；
# tsx 是 devDependency，prune 后单独补装
RUN npm prune --omit=dev --ignore-scripts && npm i tsx@^4.21.0 --no-save --ignore-scripts --no-audit --no-fund --registry=${NPM_REGISTRY}

# ===== 运行时 =====
FROM ${BASE_REGISTRY}node:22-bookworm-slim
ARG HUOBAO_VERSION=dev
ARG APT_MIRROR
ENV NODE_ENV=production \
    HUOBAO_VERSION=${HUOBAO_VERSION} \
    PORT=5679 \
    FFMPEG_BIN=/usr/bin/ffmpeg \
    FFPROBE_BIN=/usr/bin/ffprobe \
    HUOBAO_DATA_DIR=/app/data \
    SQLITE_PATH=/app/data/huobao.sqlite3 \
    WORKSPACE_PATH=/app/data/workspace \
    FRONTEND_DIST=/app/frontend-dist

# ffprobe-static 不包含 Linux ARM64 二进制；两个架构统一使用系统媒体工具。
# 字幕压制（libass）需要中日韩字体，slim 镜像默认没有，装体积较小的文泉驿微米黑。
RUN if [ -n "$APT_MIRROR" ]; then \
    sed -i "s|deb.debian.org|${APT_MIRROR}|g; s|security.debian.org|${APT_MIRROR}|g" /etc/apt/sources.list.d/debian.sources; \
  fi \
  && apt-get -o Acquire::Retries=5 update \
  && apt-get -o Acquire::Retries=5 install -y --no-install-recommends ffmpeg fonts-wqy-microhei \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY --from=backend-build /build/backend/src ./backend/src
COPY --from=backend-build /build/backend/node_modules ./backend/node_modules
COPY --from=backend-build /build/backend/package.json ./backend/package.json
COPY --from=backend-build /build/backend/tsconfig.json ./backend/tsconfig.json
# workspace 模板（skills/prompts），entrypoint copy-once 到数据卷后可在线编辑
COPY backend/workspace ./workspace-template
COPY --from=frontend-build /build/frontend/.output/public ./frontend-dist
COPY docker/entrypoint.sh ./entrypoint.sh
RUN chmod +x ./entrypoint.sh && mkdir -p /app/data

# 数据卷：SQLite + 生成的静态文件 + 可编辑 workspace
VOLUME ["/app/data"]
EXPOSE 5679

HEALTHCHECK --interval=30s --timeout=5s --start-period=15s \
  CMD node -e "fetch('http://localhost:'+(process.env.PORT||5679)+'/api/v1/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

ENTRYPOINT ["./entrypoint.sh"]
