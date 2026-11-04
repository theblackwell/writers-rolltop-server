# syntax=docker/dockerfile:1
FROM node:26-alpine AS build
WORKDIR /studio
COPY package*.json ./
COPY packages/document-adapter/package.json packages/document-adapter/package.json
RUN npm ci --ignore-scripts
COPY . .
RUN npm run check && npm run build

FROM node:26-alpine AS runtime
ENV NODE_ENV=production HOST=0.0.0.0 PORT=4317
WORKDIR /studio
COPY package*.json ./
COPY packages/document-adapter/package.json packages/document-adapter/package.json
RUN npm ci --omit=dev --ignore-scripts && npm cache clean --force
COPY --from=build /studio/packages ./packages
COPY --from=build /studio/dist ./dist
RUN mkdir -p /studio/backups && chown node:node /studio/backups && chmod 700 /studio/backups
USER node
EXPOSE 4317
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s CMD node -e "fetch('http://127.0.0.1:4317/api/health').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"
CMD ["node", "packages/studio/src/main.ts"]
