# 🐳 Dockerfile for Z-ZERO AI-CARD MCP SERVER

# 1. Build Stage
FROM node:20-slim AS builder

WORKDIR /app

# Install dependencies for build
COPY package*.json ./
RUN npm install

# Copy source and build
COPY . .
RUN npm run build

# 2. Production Stage
FROM node:20-slim

WORKDIR /app

# Install Playwright dependencies (system libraries)
RUN apt-get update && apt-get install -y \
    libnss3 \
    libnspr4 \
    libatk1.0-0 \
    libatk-bridge2.0-0 \
    libcups2 \
    libdrm2 \
    libxkbcommon0 \
    libxcomposite1 \
    libxdamage1 \
    libxext6 \
    libxfixes3 \
    librandr2 \
    libgbm1 \
    libasound2 \
    libpangocairo-1.0-0 \
    libpango-1.0-0 \
    libcairo2 \
    && rm -rf /var/lib/apt/lists/*

# Copy production files
COPY --from=builder /app/package*.json ./
COPY --from=builder /app/dist ./dist

# Install production dependencies and Playwright browsers
RUN npm install --production
RUN npx playwright install chromium

# Environment variables (to be overridden at runtime)
ENV Z_ZERO_API_BASE_URL="https://z-zero.xyz"
ENV PORT=3001

EXPOSE 3001

# Run the MCP Server
CMD ["node", "dist/index.js"]
