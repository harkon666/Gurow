# The Hono backend, run from source by Bun. Migrations are applied before it starts.
FROM oven/bun:1
WORKDIR /app
COPY backend/package.json backend/bun.lock ./
RUN bun install --frozen-lockfile --production
COPY backend/tsconfig.json ./
COPY backend/drizzle ./drizzle
COPY backend/src ./src
USER bun
EXPOSE 3001
CMD ["sh", "-c", "bun run src/db/migrate.ts && exec bun run src/index.ts"]
