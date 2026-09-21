import { z } from 'zod';
import dotenv from 'dotenv';

dotenv.config();

const envSchema = z.object({
  PORT: z.coerce.number().default(3000),
  GITHA_BRIDGE_API_KEY: z.string(),
  GITHA_BRIDGE_SECRET: z.string().optional(),
  GITHA_WEBHOOK_URL: z.string().url().default('http://localhost:8085/internal/events/broadcast'),
  GITHA_BACKEND_URL: z.string().url().default('http://localhost:8080'),
});

const result = envSchema.safeParse(process.env);

if (!result.success) {
  console.error('❌ Invalid environment variables:', JSON.stringify(result.error.format(), null, 2));
  process.exit(1);
}

export const env = result.data;
