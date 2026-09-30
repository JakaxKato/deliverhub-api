# Railway deployment for DeliverHub API (Bun + Hono + Prisma)
FROM oven/bun:1 AS base
WORKDIR /app

FROM base AS install
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile

FROM base AS release
COPY --from=install /app/node_modules node_modules
COPY . .
RUN bunx prisma generate

EXPOSE 4000
CMD ["bun", "scripts/start.ts"]
