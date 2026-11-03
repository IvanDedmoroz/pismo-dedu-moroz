FROM node:24-bookworm-slim
WORKDIR /app
COPY --chown=node:node server.mjs ./server.mjs
COPY --chown=node:node public ./public
RUN mkdir -p /app/data && chown -R node:node /app
ENV NODE_ENV=production PORT=3000 DATA_DIR=/app/data
EXPOSE 3000
USER node
CMD ["node", "server.mjs"]
