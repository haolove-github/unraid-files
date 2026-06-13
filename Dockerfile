FROM node:20-alpine

WORKDIR /app
COPY package.json server.js ./
COPY public ./public

ENV NODE_ENV=production
ENV PORT=8080
ENV UNRAID_USER_ROOT=/mnt/user
ENV UNRAID_MNT_ROOT=/mnt

EXPOSE 8080
CMD ["node", "server.js"]
