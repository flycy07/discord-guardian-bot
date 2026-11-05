FROM node:20-alpine
WORKDIR /app
COPY package*.json ./
RUN npm install --omit=dev
COPY src ./src
ENV NODE_ENV=production DATA_DIR=/data
VOLUME /data
EXPOSE 3000
CMD ["sh", "-c", "node src/deploy-commands.js && node src/index.js"]
