# Multi-stage Dockerfile for API
# Assumes the repo root contains the application (monorepo). This Dockerfile installs pnpm via corepack and runs the app.

FROM node:20-alpine AS base
ENV NODE_ENV=production
WORKDIR /app

# Install runtime dependencies used for package installation/build
RUN apk add --no-cache --virtual .build-deps git python3 make g++ curl

# Enable corepack to use pnpm
RUN corepack enable && corepack prepare pnpm@latest --activate

# Copy package manager files first for better caching
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json ./

# Install dependencies (works with pnpm workspace)
RUN pnpm install --frozen-lockfile --prod

# Copy rest of repo
COPY . .

# Ensure curl exists for healthchecks
RUN apk add --no-cache curl

# Create non-root user
RUN addgroup -S app && adduser -S app -G app
USER app

EXPOSE 8080
CMD ["node","start.mjs"]
