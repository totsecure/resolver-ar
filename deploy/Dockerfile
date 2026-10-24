FROM node:24-alpine

# Resolver-ar NO necesita el padrón (1.4 GB) para funcionar: con stock.db
# alcanza para panel, stock, saldeadas, pedir y el bot. El padrón es opcional
# (se monta como volumen en /app/datos/padron.db para /texto, /lote, /ficha).
WORKDIR /app

# Dependencias primero (mejor cache).
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

COPY . .

# El server corre como usuario sin privilegios.
RUN mkdir -p /app/datos && chown -R node:node /app
USER node

ENV NODE_ENV=production \
    PORT=3001 \
    HOST=0.0.0.0 \
    TZ=America/Argentina/Buenos_Aires

EXPOSE 3001

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3001)+'/health?token='+process.env.RESOLVER_TOKEN).then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "server.js"]
