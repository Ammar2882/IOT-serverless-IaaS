import { z } from "zod";

const envSchema = z.object({
  AWS_REGION: z.string().min(1),
  QUEUE_URL: z.string().url(),
  TABLE_NAME: z.string().min(1),
  PORT: z.coerce.number().int().positive().default(3000),
  VISIBILITY_TIMEOUT_SECONDS: z.coerce.number().int().positive().default(60),
  MAX_MESSAGES: z.coerce.number().int().min(1).max(10).default(10),
});

const parsed = envSchema.safeParse(process.env);

if (!parsed.success) {
  console.error(
    JSON.stringify({
      level: "fatal",
      event: "invalid_configuration",
      errors: parsed.error.flatten(),
    })
  );

  process.exit(1);
}

export const config = parsed.data;