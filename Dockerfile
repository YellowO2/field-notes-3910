FROM node:22.21.1-slim
WORKDIR /bot
COPY package.json main.js brain.js botmap.js ./
ENTRYPOINT ["node", "/bot/main.js"]
