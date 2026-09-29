# Node 20 LTS — processo unico hanork-beta
FROM node:20-bookworm-slim

WORKDIR /app

# Dependencias nativas ocasionais (sharp etc.)
RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates \
    python3 \
    make \
    g++ \
  && rm -rf /var/lib/apt/lists/*

COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY . .

# Runtime data (volumes no compose)
RUN mkdir -p /app/data

ENV NODE_ENV=production
ENV HEALTH_HOST=0.0.0.0
ENV HEALTH_PORT=3847

EXPOSE 3847

HEALTHCHECK --interval=30s --timeout=5s --start-period=40s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.HEALTH_PORT||3847)+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "index.js"]
