# StoryForge 云数据库服务
#
# 零运行时依赖：只用 Node 内置模块（node:http / node:sqlite / node:crypto），
# 所以镜像里不需要 `npm install`，也没有 native 编译。
#
# node:sqlite 需要 Node >= 22.5；这里用 22-alpine 官方镜像（已内置 SQLite）。
FROM node:22-alpine

WORKDIR /app

# 只拷源码，不带 node_modules（本来也没有）
COPY package.json ./
COPY src ./src
COPY scripts ./scripts

# 数据目录归 node 用户所有，避免以 root 运行
RUN mkdir -p /data && chown -R node:node /app /data

ENV NODE_ENV=production \
    SF_DATA_DIR=/data \
    SF_PORT=8787 \
    SF_HOST=0.0.0.0

USER node

EXPOSE 8787

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.SF_PORT||8787)+'/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "--disable-warning=ExperimentalWarning", "src/index.mjs"]
