FROM node:22-alpine
WORKDIR /app
# No dependencies to install: the app uses only Node built-ins.
COPY package.json ./
COPY src ./src
COPY public ./public
RUN mkdir -p /app/data && chown -R node:node /app/data
USER node
ENV HOST=0.0.0.0 PORT=3000 SENTINEL_DATA_DIR=/app/data
EXPOSE 3000
HEALTHCHECK CMD wget -qO- http://127.0.0.1:3000/api/health || exit 1
CMD ["node", "src/server.js"]
