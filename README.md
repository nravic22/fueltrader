# Fuel Trader

A RAG-style app that answers natural-language questions about UK fuel prices
("cheapest E10 near me that's open now", "cheapest fuel stops from Manchester
to Leeds") by running structured queries against a Postgres/PostGIS database,
rather than classic vector/embedding search — see "Why structured, not
vector, RAG" below for why, and the one deliberate exception to that rule.

Built for: Next.js on Vercel, Supabase (Postgres + PostGIS), a switchable LLM
provider (Google Gemini / Anthropic Claude / OpenAI) for query parsing and
answer generation, ChromaDB for semantic brand-name matching, OSRM for route
planning, MapLibre GL for the map, and GitHub Actions for scheduled data
refresh.

## Architecture

```
CSV feed (updated periodically)
        │
        ▼ (intended: GitHub Actions, scheduled — see Known limitations)
scripts/ingest.mjs  ──►  Supabase (Postgres + PostGIS)
scripts/embed-stations.mjs  ──►  Chroma (station name/brand embeddings)
                                │
                                ▼ (only on user query — fast, cheap)
Visitor question ──► app/api/query/route.ts
                        │
                        ├─ 1. parseQueryIntent()      — LLM extracts structured search params,
                        │                               incl. whether it's an A-to-B route query
                        ├─ 2a. geocode() if needed     — free Nominatim lookup for place names
                        ├─ 2b. getDrivingRoute()       — free OSRM route, only for A-to-B queries
                        ├─ 3. runStationQuery() /
                        │    runRouteStationQuery()    — real SQL query (never embeddings for
                        │                                price/distance — see exception below)
                        └─ 4. summarizeResults()       — LLM phrases the *actual* returned rows
                                │
                                ▼
                    { answer, results[], route? } ──► map + details list
```

## Why structured, not vector, RAG

Most questions here ("cheapest," "nearest," "open now") are filter/sort
operations, not semantic similarity lookups. Embeddings can't guarantee
numeric correctness ("the actual lowest price" vs. "text that talks about
being cheap"), which matters a lot when the numbers are real fuel prices.
So retrieval here is a real SQL query with `ORDER BY price ASC`, and the LLM's
only job is turning already-correct rows into a natural sentence.

**The one exception:** matching a brand name the visitor typed loosely (e.g.
"Tesco") against the messy real-world station-name strings in the data (e.g.
"TESCO SUPERSTORE MANCHESTER") is a genuine fuzzy-text problem, not a numeric
one — that's what `lib/semanticSearch.ts` + ChromaDB are for. It's additive,
not a replacement: matches are the union of an exact substring match and a
semantic match, and anything that only matched semantically is flagged
(`matched_via_semantic`) and shown with a "🔍 Similar name" badge, so it's
never a silent guess.

## Features

- **Natural-language search**: "cheapest E10 near me that's open now",
  filtered by fuel type, brand, amenities, radius, open-now status.
- **Trip/route planning**: "cheapest fuel stops from Manchester to Leeds" —
  geocodes both places, fetches a real driving route (OSRM), and finds
  stations in a corridor along the *actual road route* (not a straight line),
  evenly sampled so results span the whole trip, not just the start.
  - Defaults to showing every station found along the way; ask for "top 5
    cheapest" / "cheapest 10 stops" etc. to cap it to your N cheapest,
    globally ranked across the whole route, then re-sorted back into
    start-to-finish order.
- **Semantic brand matching**: typos/informal brand names still match, via
  ChromaDB (see above).
- **Switchable LLM provider**: Google Gemini, Anthropic Claude, or OpenAI —
  set `LLM_PROVIDER` (see `.env.example`).
- **Mobile-friendly**: two tabs on small screens (Map+search / Results), so
  the map, query box, and results don't all fight for the same screen.
- **Voice input**, **fullscreen map**, click-to-focus on a result to pan/
  highlight its pin on the map.

## Setup

### 1. Supabase

1. Create a free project at [supabase.com](https://supabase.com).
2. In the SQL Editor, run `supabase/schema.sql` (this enables PostGIS,
   creates the `stations` table, and defines the `nearby_stations` search
   function).
3. Copy your project URL and **anon** key into `.env.local` (see
   `.env.example`) — used by the app for read queries.
4. Copy your **service role** key — used only by the ingestion/embedding
   scripts, never the app itself. Add it as a GitHub Actions secret once you
   set one up (see Known limitations), not to a deployed environment.

### 2. Environment variables

Copy `.env.example` to `.env.local` and fill in Supabase's values, plus:
- `LLM_PROVIDER` (`google`, `anthropic`, or `openai`) and the matching API
  key. Google's free tier is easiest to start with (generous daily quota);
  Anthropic and OpenAI are pay-as-you-go from the first request.
- `OPENAI_API_KEY` — required for semantic brand matching regardless of
  `LLM_PROVIDER`, since embeddings always go through OpenAI's embeddings API.
  Leave blank to skip semantic matching (falls back to plain substring
  matching automatically, no errors).

### 3. ChromaDB (semantic brand matching)

Optional, but needed for fuzzy/typo-tolerant brand matching:

```bash
npx chroma run                              # local server, persists to ./ (in a separate terminal)
npm run embed                               # embeds all stations into it
```

For a deployed/serverless environment (Vercel can't run a local `chroma run`
process), use [Chroma Cloud](https://trychroma.com/signup) instead: set
`CHROMA_API_KEY`, `CHROMA_TENANT`, `CHROMA_DATABASE` in `.env.local`/Vercel,
then re-run `npm run embed` once with those set to populate the cloud
collection (it auto-detects Cloud vs local from those env vars).

### 4. Local development

```bash
npm install
npm run ingest -- --file ./data/sample-fuel-prices.csv   # one-time: load sample data
npm run embed                                              # one-time: populate Chroma (optional)
npm run dev
```

### 5. Scheduled data refresh

Intended to run via GitHub Actions on a schedule (`npm run ingest`, then
`npm run embed` to keep semantic matching in sync) — **this workflow doesn't
exist in this repo yet**, only the scripts it would call. Until it's set up,
re-run both commands manually when you have new station data. See Known
limitations.

### 6. Deploy to Vercel

1. Import this repository at [vercel.com/new](https://vercel.com/new).
2. Add the same env vars as step 2 (and Chroma Cloud vars from step 3) in the
   Vercel project settings.
3. Deploy. Note Vercel's Hobby (free) tier restricts commercial use and
   caps serverless function duration — check current limits at
   vercel.com/pricing if this becomes a production/commercial deployment.

## Map provider

Uses [MapLibre GL JS](https://maplibre.org/) (MIT-licensed, no API key)
with free vector tiles from [OpenFreeMap](https://openfreemap.org/) — no
billing account required, unlike Google Maps. Driving routes come from
[OSRM's public demo server](https://project-osrm.org/) — also free, no API
key, not intended for high-volume production traffic but fine at this app's
scale (same tradeoff as the free map tiles and geocoder below).

## Voice input

Uses the browser's native Web Speech API — free, no server round-trip.
Support varies by browser (best in Chrome/Edge); falls back to typing
automatically if unsupported.

## Dev-only: Gemini quota display

When `LLM_PROVIDER=google`, a small line under the search box shows roughly
how many of today's free-tier requests have been used (self-tracked in a
local `.dev-quota-state.json` file, since Google's API exposes no "remaining
quota" endpoint — treat it as a lower bound, not ground truth). Not shown for
other providers, and not meaningful in production.

## Known limitations / next steps

- **No GitHub Actions workflow yet** — `scripts/ingest.mjs` and
  `scripts/embed-stations.mjs` are both designed to run on a schedule, but
  the workflow file itself hasn't been created. Worth doing before relying
  on this for real, continuously-updated data.
- Geocoding (`lib/geocode.ts`) uses Nominatim's free tier, rate-limited to
  ~1 request/second — fine at small scale, swap for a paid geocoder if
  traffic grows.
- Route directions use OSRM's public demo server, similarly rate-limited and
  not guaranteed for production — swap for a paid routing API (Mapbox
  Directions, GraphHopper, ORS) if traffic grows.
- No rate limiting or abuse protection is wired in yet on `/api/query` —
  worth adding (per-IP + daily cap) before any public launch.
- The upstream CSV source URL is a placeholder — replace with the actual
  feed once confirmed.
