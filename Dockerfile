FROM node:22

WORKDIR /opt/cork-cache-n-queue

COPY package.json package-lock.json* ./
RUN npm install --omit=dev

COPY src ./src
COPY sql ./sql

CMD ["node", "src/server.js"]
