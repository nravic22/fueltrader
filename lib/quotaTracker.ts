import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

// Dev-only, self-tracked approximation of Google's free-tier daily request
// quota — Google doesn't expose a "remaining quota" API, so this just counts
// calls this app makes and compares against the cap we've observed in 429
// responses (GenerateRequestsPerDayPerProjectPerModel-FreeTier = 20). It
// can't see usage from outside this app (e.g. AI Studio's own playground),
// so treat it as a lower bound, not ground truth.
const GOOGLE_FREE_TIER_DAILY_LIMIT = 20;
const STATE_FILE = join(process.cwd(), '.dev-quota-state.json');

interface QuotaState {
  date: string; // YYYY-MM-DD in America/Los_Angeles, since that's when Google's daily quotas reset
  count: number;
}

function todayPacific(): string {
  return new Date().toLocaleDateString('en-CA', { timeZone: 'America/Los_Angeles' }); // en-CA gives YYYY-MM-DD
}

function readState(): QuotaState {
  try {
    if (existsSync(STATE_FILE)) {
      const parsed = JSON.parse(readFileSync(STATE_FILE, 'utf8')) as QuotaState;
      if (parsed.date === todayPacific()) return parsed;
    }
  } catch {
    // Corrupt or unreadable state file — just start fresh.
  }
  return { date: todayPacific(), count: 0 };
}

function writeState(state: QuotaState) {
  try {
    writeFileSync(STATE_FILE, JSON.stringify(state));
  } catch {
    // Best-effort only — a failed write just means the count doesn't persist across restarts.
  }
}

/** Call once per outgoing Google LLM request (parseQueryIntent, summarizeResults, ...). */
export function recordGoogleLLMCall(): void {
  const state = readState();
  state.count += 1;
  writeState(state);
}

export function getGoogleQuotaStatus() {
  const state = readState();
  return {
    used: state.count,
    limit: GOOGLE_FREE_TIER_DAILY_LIMIT,
    remaining: Math.max(0, GOOGLE_FREE_TIER_DAILY_LIMIT - state.count),
    date: state.date,
  };
}
