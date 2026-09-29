# relay-realtime on Cloud Run (see deploy.sh).
FROM node:22-slim
WORKDIR /app
ENV NODE_ENV=production
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund
COPY coalesce.mjs relay.mjs ./
USER node
CMD ["node", "relay.mjs"]
