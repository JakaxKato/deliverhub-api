import { z } from "zod";

const envSchema = z.object({
  PORT: z.string().default("4000").transform(Number),
  DATABASE_URL: z.string(),
  JWT_SECRET: z.string().default("nodewave-super-secret-jwt-key-2026-production-grade"),
  JWT_EXPIRES_IN: z.string().default("7d"),
  CORS_ORIGIN: z.string().default("http://localhost:3000"),
  NODE_ENV: z.enum(["development", "production", "test"]).default("development"),
});

const parsed = envSchema.safeParse(process.env);

if (!parsed.success) {
  console.error("❌ Invalid environment configuration:", parsed.error.format());
  process.exit(1);
}

export const env = parsed.data;
