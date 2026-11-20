import { z } from 'zod';

const ConfigSchema = z.object({
  PORT: z.coerce.number().int().positive().default(3100),
  DATABASE_URL: z.string().min(1),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
  /** Max allowed skew between a webhook's signed timestamp and server time (replay protection). */
  WEBHOOK_TOLERANCE_SECONDS: z.coerce.number().int().positive().default(300),
  /** Server-only key of the spin RNG; whoever knows it can predict outcomes. */
  SPIN_SEED_SECRET: z.string().min(32),
  /** Upper bound on a casino-issued player token's age, whatever its own `exp` says. */
  PLAYER_TOKEN_MAX_AGE_SECONDS: z.coerce.number().int().positive().default(3600),
});

export type AppConfig = z.infer<typeof ConfigSchema>;

export const APP_CONFIG = Symbol('APP_CONFIG');

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const parsed = ConfigSchema.safeParse(env);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ');
    throw new Error(`Invalid configuration: ${issues}`);
  }
  return parsed.data;
}
