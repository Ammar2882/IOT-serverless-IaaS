# ---- Build stage: compiles TypeScript, has full devDependencies ----
FROM node:22-alpine AS build

WORKDIR /AWS-IOT

COPY package*.json ./

RUN npm ci

COPY tsconfig.json ./
COPY src ./src
COPY shared ./shared

RUN npm run build

# ---- Runtime stage: only production deps + compiled output ----
FROM node:22-alpine AS runtime

WORKDIR /AWS-IOT
ENV NODE_ENV=production

COPY package*.json ./

RUN npm ci --omit=dev && npm cache clean --force

COPY --from=build /AWS-IOT/dist ./dist

# The official node:alpine image already ships a non-root "node" user.
USER node

EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
  CMD node -e "require('http').get('http://127.0.0.1:' + (process.env.PORT || 3000) + '/health', (res) => process.exit(res.statusCode === 200 ? 0 : 1)).on('error', () => process.exit(1))"

CMD ["node", "dist/src/main.js"]
