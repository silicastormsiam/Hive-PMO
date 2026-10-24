FROM node:24-alpine
WORKDIR /app
COPY package.json ./
RUN npm install --omit=dev
COPY server.mjs ./
COPY watch.mjs ./
COPY costs.mjs ./
COPY public ./public
EXPOSE 3470
CMD ["node", "server.mjs"]
