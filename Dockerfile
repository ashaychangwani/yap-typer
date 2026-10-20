FROM node:24-alpine

LABEL org.opencontainers.image.source="https://github.com/ashaychangwani/yap-typer" \
      org.opencontainers.image.description="Shared Todo list and timed brain dump sessions" \
      org.opencontainers.image.licenses="MIT"

ENV NODE_ENV=production \
    PORT=4173 \
    HOST=0.0.0.0 \
    YAP_TYPER_DATA_DIR=/data

WORKDIR /app
COPY --chown=node:node package.json server.mjs LICENSE ./
COPY --chown=node:node public ./public

RUN mkdir -p /data && chown node:node /data
USER node

VOLUME ["/data"]
EXPOSE 4173
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s \
  CMD node -e "fetch('http://127.0.0.1:4173/').then(r => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))"

CMD ["node", "server.mjs"]
