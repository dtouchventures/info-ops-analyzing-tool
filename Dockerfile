# AIVS server image. Build: docker build -t aivs .   Run with docker compose (see deploy/docker-compose.yml).
FROM node:22-bookworm-slim
ENV NODE_ENV=production HOST=0.0.0.0 PORT=8080 TRUST_PROXY=true COOKIE_SECURE=true DATA_DIR=/app/data BACKUP_DIR=/app/backups
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund && npm cache clean --force
COPY server ./server
COPY shared ./shared
COPY public ./public
COPY training ./training
RUN mkdir -p /app/data /app/backups && chown -R node:node /app/data /app/backups
USER node
EXPOSE 8080
HEALTHCHECK --interval=60s --timeout=5s --start-period=30s CMD node -e "fetch('http://127.0.0.1:8080/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "server/index.js"]
