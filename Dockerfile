FROM node:22.21.1-slim
WORKDIR /bot
COPY . ./
ENTRYPOINT ["node", "/bot/main.js"]
