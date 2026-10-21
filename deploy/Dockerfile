FROM node:24-alpine

# La DB real (datos/padron.db, ~757 MB) NO se hornea en la imagen:
# montar un volumen en /app/datos.
#   docker build -f deploy/Dockerfile -t resolver-ar .
#   docker run -p 3001:3001 -e RESOLVER_TOKEN=... -v /opt/resolver/datos:/app/datos resolver-ar
WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY . .

ENV NODE_ENV=production
ENV PORT=3001
EXPOSE 3001

CMD ["node", "server.js"]
