FROM node:22-slim
WORKDIR /app
COPY package.json ./
ENV ONNXRUNTIME_NODE_INSTALL_CUDA=skip
RUN npm install --omit=dev
COPY src ./src
ENV NODE_ENV=production
USER node
EXPOSE 4000
CMD ["node","src/index.js"]
