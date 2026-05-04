FROM node:20-slim

# Chromium + fontes para o Puppeteer gerar PDF
# libvips não é necessário — sharp usa binários pré-compilados desde v0.33
RUN apt-get update && apt-get install -y \
    chromium \
    fonts-noto \
    fonts-noto-color-emoji \
    --no-install-recommends \
  && apt-get clean \
  && rm -rf /var/lib/apt/lists/*

ENV PUPPETEER_SKIP_CHROMIUM_DOWNLOAD=true \
    PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium \
    NODE_ENV=production \
    PORT=3000

WORKDIR /app

COPY package*.json ./
RUN npm ci --omit=dev

COPY . .

# Garante que o diretório de dados existe e pertence ao usuário node
RUN mkdir -p /app/data && chown -R node:node /app/data

EXPOSE 3000

# Usuário não-root por segurança
USER node

CMD ["node", "server.js"]
