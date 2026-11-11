FROM node:24-bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends ffmpeg ca-certificates \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev
COPY src ./src
# settings.json lives here; the app runs as node, so it must own the directory
RUN mkdir -p data recordings && chown node:node data recordings
ENV NODE_ENV=production SCREEN_ENABLED=false
EXPOSE 8080
USER node
CMD ["node", "src/index.js"]
