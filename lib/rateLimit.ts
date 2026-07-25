import { Ratelimit } from '@upstash/ratelimit';
import { Redis } from '@upstash/redis';

// Guards /api/query against token/cost abuse: a burst limit (stop rapid-fire
// spamming) and a daily cap per IP (bound worst-case spend from one actor).
// Falls back to "always allowed" if Upstash isn't configured, so local dev
// works without setting it up — this is a production hardening layer, not a
// required dependency.
const redis =
  process.env.UPSTASH_REDIS_REST_URL && process.env.UPSTASH_REDIS_REST_TOKEN ? Redis.fromEnv() : null;

const burstLimiter = redis
  ? new Ratelimit({ redis, limiter: Ratelimit.slidingWindow(10, '1 m'), prefix: 'fueltrader:burst' })
  : null;

const dailyLimiter = redis
  ? new Ratelimit({ redis, limiter: Ratelimit.slidingWindow(100, '1 d'), prefix: 'fueltrader:daily' })
  : null;

export interface RateLimitResult {
  allowed: boolean;
  message?: string;
  retryAfterSeconds?: number;
}

export async function checkRateLimit(identifier: string): Promise<RateLimitResult> {
  if (!burstLimiter || !dailyLimiter) {
    return { allowed: true }; // Upstash not configured — skip (e.g. local dev)
  }

  const [burst, daily] = await Promise.all([burstLimiter.limit(identifier), dailyLimiter.limit(identifier)]);

  if (!burst.success) {
    return {
      allowed: false,
      message: "You're searching a bit fast — please wait a moment and try again.",
      retryAfterSeconds: Math.ceil((burst.reset - Date.now()) / 1000),
    };
  }

  if (!daily.success) {
    return {
      allowed: false,
      message: "You've reached today's search limit — please try again tomorrow.",
      retryAfterSeconds: Math.ceil((daily.reset - Date.now()) / 1000),
    };
  }

  return { allowed: true };
}
