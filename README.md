# Fuel Trader

A RAG-style app that answers natural-language questions about UK fuel prices
("cheapest E10 near me that's open now") by running structured queries
against a Postgres/PostGIS database, rather than classic vector/embedding
search — see the "Why structured, not vector, RAG" section below for why.

Built for: Next.js on Vercel, Supabase (Postgres + PostGIS), Anthropic Claude
Haiku for query parsing/answer generation, MapLibre GL for the map, and
GitHub Actions for scheduled data refresh.

## Architecture

```
CSV feed (updated periodically)
        │
        ▼ (GitHub Actions, scheduled)
scripts/ingest.mjs  ──►  Supabase (Postgres + PostGIS)
                                │
                                ▼ (only on user query — fast, cheap)
Visitor question ──► app/api/query/route.ts
                        │
                        ├─ 1. parseQueryIntent()  — LLM extracts structured search params
                        ├─ 2. geocode() if needed — free Nominatim lookup for place names
                        ├─ 3. runStationQuery()   — real SQL query (never embeddings)
                        └─ 4. summarizeResults()  — LLM phrases the *actual* returned rows
                                │
                                ▼
                    { answer, results[] } ──► map + details list
```

## Why structured, not vector, RAG

Most questions here ("cheapest," "nearest," "open now") are filter/sort
operations, not semantic similarity lookups. Embeddings can't guarantee
numeric correctness ("the actual lowest price" vs. "text that talks about
being cheap"), which matters a lot when the numbers are real fuel prices.
So retrieval here is a real SQL query with `ORDER BY price ASC`, and the LLM's
only job is turning already-correct rows into a natural sentence.

## Setup

### 1. Supabase

1. Create a free project at [supabase.com](https://supabase.com).
2. In the SQL Editor, run `supabase/schema.sql` (this enables PostGIS,
   creates the `stations` table, and defines the `nearby_stations` search
   function).
3. Copy your project URL and **anon** key into `.env.local` (see
   `.env.example`) — used by the app for read queries.
4. Copy your **service role** key — used only by the ingestion script,
   never the app itself. Add it as a GitHub Actions secret (see below), not
   to `.env.local`.

### 2. Environment variables

Copy `.env.example` to `.env.local` and fill in:
- `SUPABASE_URL`, `SUPABASE_ANON_KEY`
- `ANTHROPIC_API_KEY`

### 3. Local development

```bash
npm install
npm run ingest -- --file ./data/sample-fuel-prices.csv   # one-time: load sample data
npm run dev
```

### 4. Scheduled data refresh (GitHub Actions)

The workflow in `.github/workflows/update-fuel-data.yml` runs every 30
minutes. Add these repository secrets (Settings → Secrets and variables →
Actions):
- `SUPABASE_URL`
- `SUPABASE_SERVICE_ROLE_KEY`
- `FUEL_CSV_SOURCE_URL` (optional — the real upstream feed URL once you have
  one; without it, the workflow ingests the bundled sample CSV so it's
  runnable out of the box)

### 5. Deploy to Vercel

1. Import this repository at [vercel.com/new](https://vercel.com/new).
2. Add the same env vars as step 2 in the Vercel project settings.
3. Deploy. Note Vercel's Hobby (free) tier restricts commercial use and
   caps serverless function duration — check current limits at
   vercel.com/pricing if this becomes a production/commercial deployment.

## Map provider

Uses [MapLibre GL JS](https://maplibre.org/) (MIT-licensed, no API key)
with free vector tiles from [OpenFreeMap](https://openfreemap.org/) — no
billing account required, unlike Google Maps.

## Voice input

Uses the browser's native Web Speech API — free, no server round-trip.
Support varies by browser (best in Chrome/Edge); falls back to typing
automatically if unsupported.

## Known limitations / next steps

- Geocoding (`lib/geocode.ts`) uses Nominatim's free tier, rate-limited to
  ~1 request/second — fine at small scale, swap for a paid geocoder if
  traffic grows.
- No rate limiting or abuse protection is wired in yet on `/api/query` —
  worth adding (per-IP + daily cap) before any public launch, following the
  same pattern used in other projects in this codebase family.
- The upstream CSV source URL is a placeholder (`FUEL_CSV_SOURCE_URL`) —
  replace with the actual feed once confirmed.
