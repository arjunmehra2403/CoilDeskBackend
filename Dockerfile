
FROM node:22-bookworm-slim

WORKDIR /app

# Install Linux runtime dependencies
RUN apt-get update && apt-get install -y --no-install-recommends \
    libgomp1 \
    libstdc++6 \
    libgcc-s1 \
    ca-certificates \
    && rm -rf /var/lib/apt/lists/*

COPY package.json package-lock.json ./

ENV ONNXRUNTIME_NODE_INSTALL_CUDA=skip
ENV NODE_ENV=production

RUN npm ci --omit=dev

COPY src ./src

RUN mkdir -p uploads && chown -R node:node /app

USER node

EXPOSE 4000

CMD ["node", "src/index.js"]
