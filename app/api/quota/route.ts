import { NextResponse } from 'next/server';
import { getGoogleQuotaStatus } from '@/lib/quotaTracker';

export const runtime = 'nodejs';

// Dev-only endpoint: surfaces our self-tracked count of Google LLM calls made
// today against the free-tier daily cap, so the UI can show it during
// development. Not meaningful in production or for other providers.
export async function GET() {
  const provider = (process.env.LLM_PROVIDER ?? 'google').toLowerCase();

  if (provider !== 'google') {
    return NextResponse.json({ provider, tracked: false });
  }

  return NextResponse.json({ provider, tracked: true, ...getGoogleQuotaStatus() });
}
