FROM node:22-bookworm-slim AS build
WORKDIR /app
RUN npm install -g pnpm@10.6.1
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json ./
COPY packages ./packages
COPY apps ./apps
RUN MEDIA_SKIP_SKILL_INSTALL=1 pnpm install --frozen-lockfile --ignore-scripts && pnpm build
RUN pnpm --filter @media-ingest/api deploy --legacy --prod /runtime

FROM node:22-bookworm-slim AS runtime
RUN apt-get update && apt-get install -y --no-install-recommends ffmpeg python3 python3-pip ca-certificates tini && python3 -m pip install --break-system-packages yt-dlp yt-dlp-ejs && rm -rf /var/lib/apt/lists/*
RUN npm install -g @openai/codex@0.163.0 @anthropic-ai/claude-code@2.1.309 && codex --version && claude --version
WORKDIR /app
COPY --from=build --chown=node:node /runtime ./
RUN mkdir -p /data /auth/codex /auth/claude && chown -R node:node /data /auth
USER node
ENV NODE_ENV=production MEDIA_WORK_ROOT=/data MEDIA_PORT=4000 MEDIA_CODEX_HOME=/auth/codex MEDIA_CLAUDE_HOME=/auth/claude
EXPOSE 4000
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 CMD node -e "fetch('http://127.0.0.1:4000/healthz').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"
ENTRYPOINT ["/usr/bin/tini","--"]
CMD ["node","dist/main.js"]
