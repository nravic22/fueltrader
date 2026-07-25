import { anthropic } from '@ai-sdk/anthropic';
import { google } from '@ai-sdk/google';
import { openai } from '@ai-sdk/openai';
import { recordGoogleLLMCall } from './quotaTracker';

/**
 * Picks the LLM provider via LLM_PROVIDER env var so we can flip providers
 * without touching call sites. Defaults to google since that's what's
 * configured by default; set LLM_PROVIDER=anthropic or LLM_PROVIDER=openai
 * to switch (each needs its matching API key env var set).
 */
export function getLLMModel() {
  const provider = (process.env.LLM_PROVIDER ?? 'google').toLowerCase();

  switch (provider) {
    case 'anthropic':
      return anthropic('claude-haiku-4-5-20251001');
    case 'openai':
      return openai('gpt-4o-mini');
    case 'google':
      recordGoogleLLMCall(); // dev-only usage tracking, since Google's free tier exposes no "remaining quota" API
      return google('gemini-flash-latest');
    default:
      throw new Error(`Unknown LLM_PROVIDER "${provider}" — expected "google", "anthropic", or "openai".`);
  }
}
