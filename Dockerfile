FROM node:22.21.1-slim
WORKDIR /bot
COPY . ./
ENV SCRIPT_AIM=on POLICY_EVERY=2
ENTRYPOINT ["node", "/bot/main.js"]
