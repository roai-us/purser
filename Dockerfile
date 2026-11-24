# ROAI Purser in one container.
#
#   docker run -d --name purser -p 127.0.0.1:4141:4141 -v purser-data:/data \
#     ghcr.io/roai-us/purser
#   docker logs purser      # prints a one-time sign-in link
#
# See docs/docker.md for keys, HTTPS and the demo.

# Both stages use the same base image, pinned by digest. Dependabot keeps it current.
FROM node:24-bookworm-slim@sha256:873f586f3794f52281bd039bf02c048a0be08fde619338f9941bad1eb6b34530 AS build
WORKDIR /repo
RUN npm install -g pnpm@10.28.2 && npm cache clean --force
# Manifests first, so dependencies are cached until they change.
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json ./
COPY apps/server/package.json apps/server/
COPY apps/web/package.json apps/web/
COPY packages/roi-core/package.json packages/roi-core/
RUN pnpm install --frozen-lockfile
COPY apps apps
COPY packages packages
RUN pnpm build \
  && pnpm --filter @roai-us/purser deploy --prod --legacy /out

FROM node:24-bookworm-slim@sha256:873f586f3794f52281bd039bf02c048a0be08fde619338f9941bad1eb6b34530
ARG VERSION=dev
LABEL org.opencontainers.image.title="ROAI Purser" \
      org.opencontainers.image.description="A free, self-hosted control panel for AI agents and AI spend." \
      org.opencontainers.image.source="https://github.com/roai-us/purser" \
      org.opencontainers.image.url="https://roai.us" \
      org.opencontainers.image.licenses="Elastic-2.0 AND Apache-2.0" \
      org.opencontainers.image.version="${VERSION}"

WORKDIR /app
COPY --from=build /out/package.json ./
COPY --from=build /out/dist ./dist
COPY --from=build /out/node_modules ./node_modules
COPY --from=build /repo/apps/web/dist ./web
COPY LICENSE NOTICE LICENSING.md ./

# Inside the container Purser listens on every interface, so Docker can
# publish the port. Who can reach it is set by `docker run -p`: publish it on
# 127.0.0.1 unless HTTPS is in front. PURSER_BASE_URL is the address people
# and agents use; change it to match.
ENV NODE_ENV=production \
    PURSER_HOST=0.0.0.0 \
    PURSER_ALLOW_REMOTE=1 \
    PURSER_PORT=4141 \
    PURSER_BASE_URL=http://localhost:4141 \
    PURSER_DATA_DIR=/data \
    PURSER_WEB_DIR=/app/web

RUN mkdir -p /data && chown node:node /data
USER node
VOLUME ["/data"]
EXPOSE 4141

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+process.env.PURSER_PORT+'/health').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"

ENTRYPOINT ["node", "/app/dist/cli.js"]
CMD ["serve", "--no-open"]
