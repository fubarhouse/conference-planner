FROM node:22-alpine
COPY . .
WORKDIR /
RUN npm ci --omit=dev
COPY . .
EXPOSE 8080
CMD ["node", "server.js"]
