# 微信云托管备选。不在本仓库执行部署。
# 平台会注入 PORT；默认 80。密钥走云托管环境变量，不要打进镜像。
FROM node:22-bookworm-slim
WORKDIR /app
COPY server/package.json server/package-lock.json ./
RUN npm ci
COPY server/ ./
RUN npm run build && npm prune --omit=dev
ENV NODE_ENV=production
ENV PORT=80
EXPOSE 80
CMD ["node", "dist/index.js"]
