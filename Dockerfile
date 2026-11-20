# syntax=docker/dockerfile:1

# ---- 构建阶段：安装依赖并产出静态站点 ----
FROM node:24-alpine AS build

WORKDIR /app

# 与 .github/workflows/pages.yml 保持同一 pnpm 版本，锁文件才能冻结安装
RUN npm install -g pnpm@12.6.0

# 先只拷清单，依赖层可复用缓存
COPY package.json pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile

COPY . .

# 构建期注入 API 地址，默认指向 DeepSeek 官方服务
ARG API_ORIGIN=https://api.deepseek.com
ENV API_ORIGIN=$API_ORIGIN

RUN pnpm build

# ---- 运行阶段：单进程同时提供静态站点与对话存储 ----
FROM node:24-alpine AS runtime

WORKDIR /app

ENV NODE_ENV=production \
    PORT=3000 \
    CHAT_DATA_DIR=/data

COPY --from=build /app/dist ./dist
COPY --from=build /app/server ./server

# 数据卷归 node 用户所有：命名卷会继承这里的属主，宿主机 bind mount 需自行 chown 1000:1000。
# 顺手补齐读权限，避免在 umask 077 的机器上构建出 node 用户读不到的源码。
RUN chmod -R a+rX ./dist ./server && mkdir -p /data && chown node:node /data
USER node

VOLUME ["/data"]
EXPOSE 3000

CMD ["node", "server/index.ts"]
