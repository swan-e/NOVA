# TypeScript is compiled locally before building the image.
# Always run: npm run build   BEFORE   docker compose build

FROM node:20-slim

WORKDIR /app

# Production dependencies only
COPY package*.json ./
RUN npm ci --omit=dev

# Copy pre-compiled JS from local build folder
COPY build/ ./build/

# Copy config files (profiles.json etc.)
COPY config/ ./config/
 
# Copy state folder (email-fetch-state.json)
# This gets overwritten at runtime via volume mount if needed
COPY data/ ./data/

# .env and Obsidian vault mounted at runtime
CMD ["node", "build/index.js"]