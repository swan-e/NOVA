# Runtime-only image. build/ is volume-mounted at runtime — never baked in.
# Run `npm run build` locally, then `docker compose restart` to pick up changes.
# Only run `make rebuild` when changing package.json or this Dockerfile.

FROM node:20-slim 

WORKDIR /app

# Production dependencies only
COPY package*.json ./
RUN npm ci --omit=dev

COPY config ./config
COPY data ./data

# .env and Obsidian vault mounted at runtime
CMD ["node", "build/index.js"]