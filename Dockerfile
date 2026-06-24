FROM node:20-slim
WORKDIR /app

# build tools for better-sqlite3 native module (used only if no prebuild matches)
RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ ca-certificates \
    && rm -rf /var/lib/apt/lists/*

COPY package.json package-lock.json* ./
RUN npm install --omit=dev

COPY . .
RUN mkdir -p /app/data

EXPOSE 3000
ENV PORT=3000
ENV DATABASE_PATH=/app/data/funnel.db
CMD ["node", "server.js"]
