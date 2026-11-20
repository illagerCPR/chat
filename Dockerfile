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

# ---- 运行阶段：只用 nginx 提供静态文件 ----
FROM nginx:1.29-alpine AS runtime

COPY nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /app/dist /usr/share/nginx/html

EXPOSE 80

CMD ["nginx", "-g", "daemon off;"]
