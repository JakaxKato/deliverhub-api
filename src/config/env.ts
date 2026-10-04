import { z } from "zod";

const MAX_TOKEN_TTL_SECONDS = 30 * 24 * 60 * 60;
const legacySecret = "nodewave-super-secret-jwt-key-2026-production-grade";

function ttlSeconds(value: string): number {
  const match = /^([1-9]\d*)(s|m|h|d)?$/.exec(value);
  if (!match) return Number.NaN;
  const units: Record<string, number> = { s: 1, m: 60, h: 3600, d: 86400 };
  return Number(match[1]) * (units[match[2] ?? "s"] ?? 1);
}

function isOrigin(value: string): boolean {
  try {
    const url = new URL(value);
    return (url.protocol === "http:" || url.protocol === "https:") && url.origin === value;
  } catch {
    return false;
  }
}

const envSchema = z
  .object({
    PORT: z
      .string()
      .regex(/^[1-9]\d*$/)
      .default("4000")
      .transform(Number)
      .pipe(z.number().int().min(1).max(65535)),
    DATABASE_URL: z
      .string()
      .min(1)
      .refine((value) => {
        try {
          const url = new URL(value);
          return (
            ["postgres:", "postgresql:"].includes(url.protocol) &&
            Boolean(url.hostname) &&
            url.pathname.length > 1
          );
        } catch {
          return false;
        }
      }, "DATABASE_URL must be a PostgreSQL connection URL"),
    JWT_SECRET: z
      .string()
      .min(32)
      .max(4096)
      .refine(
        (value) => value === value.trim() && value !== legacySecret,
        "JWT_SECRET must be a new, securely generated secret without surrounding whitespace",
      ),
    JWT_EXPIRES_IN: z
      .string()
      .default("7d")
      .refine((value) => {
        const seconds = ttlSeconds(value);
        return Number.isSafeInteger(seconds) && seconds > 0 && seconds <= MAX_TOKEN_TTL_SECONDS;
      }, "Use positive seconds or an s/m/h/d duration, at most 30 days"),
    JWT_ISSUER: z.string().trim().min(1).max(200).default("nodewave-api"),
    JWT_AUDIENCE: z.string().trim().min(1).max(200).default("nodewave-web"),
    CORS_ORIGIN: z
      .string()
      .min(1)
      .transform((value) => value.split(",").map((origin) => origin.trim()))
      .pipe(
        z
          .array(
            z.string().refine(isOrigin, "Use an exact HTTP(S) origin without a path or wildcard"),
          )
          .min(1)
          .max(20),
      ),
    NODE_ENV: z.enum(["development", "production", "test"]).default("development"),
    SEED_PASSWORD: z
      .string()
      .min(12)
      .refine(
        (value) => Buffer.byteLength(value, "utf8") <= 72,
        "SEED_PASSWORD must be at most 72 UTF-8 bytes for bcrypt",
      )
      .optional(),
    ALLOW_PRODUCTION_SEED: z
      .enum(["true", "false"])
      .default("false")
      .transform((value) => value === "true"),
  })
  .transform((data) => ({
    ...data,
    JWT_TTL_SECONDS: ttlSeconds(data.JWT_EXPIRES_IN),
    CORS_ORIGINS: [...new Set(data.CORS_ORIGIN)],
  }));

const parsed = envSchema.safeParse(process.env);

if (!parsed.success) {
  // Report field names, never connection URLs, secrets, or the environment object.
  console.error(
    "Invalid environment configuration:",
    parsed.error.issues.map((issue) => ({
      field: issue.path.join("."),
      message: issue.message,
    })),
  );
  process.exit(1);
}

export const env = parsed.data;
