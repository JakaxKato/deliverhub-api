# Production image for DeliverHub API (Bun + Hono + Prisma)
FROM oven/bun:1 AS base
WORKDIR /app

FROM base AS install
ENV HUSKY=0
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile

FROM base AS release
ENV NODE_ENV=production
COPY --from=install /app/node_modules node_modules
COPY . .
RUN bun run db:generate

EXPOSE 4000
CMD ["bun", "scripts/start.ts"]
