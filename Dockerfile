# Use official Bun image
FROM oven/bun:1.1.13

# Set working directory
WORKDIR /app

# Copy deps and install
COPY bun.lock package.json ./
RUN bun install

# Copy app files
COPY . .

# Expose webhook port
EXPOSE 3003

# Start the webhook server
CMD ["bun", "redis-server.ts"]
