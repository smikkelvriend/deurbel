FROM node:22-alpine
RUN apk add --no-cache ffmpeg tzdata
WORKDIR /app
COPY server.js ./
COPY public ./public
ENV NODE_ENV=production DATA_DIR=/data
VOLUME /data
CMD ["node", "server.js"]
