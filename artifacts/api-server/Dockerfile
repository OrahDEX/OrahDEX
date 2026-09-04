FROM node:22-slim
WORKDIR /app
RUN npm install -g pnpm
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json ./
COPY artifacts/api-server/package.json artifacts/api-server/
COPY artifacts/api-server/build.mjs artifacts/api-server/
COPY artifacts/api-server/tsconfig.json artifacts/api-server/
COPY lib/ lib/
COPY artifacts/bsv-dex/package.json artifacts/bsv-dex/
RUN pnpm install --frozen-lockfile
COPY . .
RUN pnpm --filter ./artifacts/api-server run build
EXPOSE 3000
CMD ["node", "--enable-source-maps", "--max-old-space-size=4096", "--expose-gc", "./artifacts/api-server/dist/index.mjs"]
