#!/usr/bin/env node
/**
 * Builds/refreshes the Chroma collection used for semantic brand/station-name
 * matching (e.g. matching "Tesco" to "TESCO SUPERSTORE MANCHESTER"). Run this
 * once after `npm run ingest`, and again whenever station data changes.
 *
 * Usage:
 *   node scripts/embed-stations.mjs
 *
 * By default connects to a local Chroma server running in another terminal:
 * `npx chroma run` (persists to disk automatically, no separate install —
 * native bindings, no Python needed). To sync a Chroma Cloud collection
 * instead (e.g. before/after deploying to Vercel), set CHROMA_API_KEY (and
 * CHROMA_TENANT / CHROMA_DATABASE) and this will target Cloud automatically.
 * Also requires SUPABASE_URL and SUPABASE_ANON_KEY.
 */

import { createClient } from '@supabase/supabase-js';
import { ChromaClient, CloudClient } from 'chromadb';
import { OpenAIEmbeddingFunction } from '@chroma-core/openai';

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY;

if (!SUPABASE_URL || !SUPABASE_ANON_KEY) {
  console.error('Missing SUPABASE_URL or SUPABASE_ANON_KEY environment variables.');
  process.exit(1);
}
if (!process.env.OPENAI_API_KEY) {
  console.error('Missing OPENAI_API_KEY environment variable (used for embeddings, independent of LLM_PROVIDER).');
  process.exit(1);
}

const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
const chroma = process.env.CHROMA_API_KEY
  ? new CloudClient({
      apiKey: process.env.CHROMA_API_KEY,
      tenant: process.env.CHROMA_TENANT,
      database: process.env.CHROMA_DATABASE,
    })
  : new ChromaClient({
      host: process.env.CHROMA_HOST ?? 'localhost',
      port: process.env.CHROMA_PORT ? Number(process.env.CHROMA_PORT) : 8000,
    });

async function fetchAllStations() {
  const PAGE_SIZE = 1000; // Supabase/PostgREST caps unpaginated selects at 1000 rows
  const rows = [];
  let from = 0;

  while (true) {
    const { data, error } = await supabase
      .from('stations')
      .select('node_id, trading_name, brand_name')
      .eq('temporary_closure', false)
      .range(from, from + PAGE_SIZE - 1);
    if (error) throw error;

    rows.push(...data);
    if (data.length < PAGE_SIZE) break;
    from += PAGE_SIZE;
  }

  return rows;
}

async function main() {
  console.log('Fetching stations from Supabase...');
  const data = await fetchAllStations();

  console.log(`Fetched ${data.length} stations. Connecting to local Chroma server...`);

  const collection = await chroma.getOrCreateCollection({
    name: 'station-names',
    embeddingFunction: new OpenAIEmbeddingFunction({
      apiKey: process.env.OPENAI_API_KEY,
      modelName: 'text-embedding-3-small',
    }),
  });

  const BATCH_SIZE = 200;
  for (let i = 0; i < data.length; i += BATCH_SIZE) {
    const batch = data.slice(i, i + BATCH_SIZE);
    await collection.upsert({
      ids: batch.map((s) => s.node_id),
      documents: batch.map((s) => [s.brand_name, s.trading_name].filter(Boolean).join(' ')),
      metadatas: batch.map((s) => ({
        trading_name: s.trading_name ?? '',
        brand_name: s.brand_name ?? '',
      })),
    });
    console.log(`Embedded batch ${Math.floor(i / BATCH_SIZE) + 1} (${batch.length} stations).`);
  }

  console.log('Done — station-names collection is up to date.');
}

main().catch((err) => {
  console.error('Embedding sync failed:', err);
  process.exit(1);
});
