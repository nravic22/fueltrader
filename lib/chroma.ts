import { ChromaClient, CloudClient, type Collection } from 'chromadb';
import { OpenAIEmbeddingFunction } from '@chroma-core/openai';

// Uses OpenAI's embedding API rather than a local ONNX model, specifically so
// this works well in serverless (Vercel) functions — no large model to load
// on every cold start. Requires OPENAI_API_KEY, independent of whichever
// LLM_PROVIDER is chosen for text generation.
const embeddingFunction = new OpenAIEmbeddingFunction({
  apiKey: process.env.OPENAI_API_KEY,
  modelName: 'text-embedding-3-small',
});

const STATION_NAMES_COLLECTION = 'station-names';

let client: ChromaClient | null = null;
let collectionPromise: Promise<Collection> | null = null;

function getClient(): ChromaClient {
  if (!client) {
    // Vercel (and any serverless/production deploy) can't run a local
    // `chroma run` sidecar process, so use Chroma Cloud when its env vars
    // are set; otherwise fall back to a local server for dev (`npx chroma run`).
    client = process.env.CHROMA_API_KEY
      ? new CloudClient({
          apiKey: process.env.CHROMA_API_KEY,
          tenant: process.env.CHROMA_TENANT,
          database: process.env.CHROMA_DATABASE,
        })
      : new ChromaClient({
          host: process.env.CHROMA_HOST ?? 'localhost',
          port: process.env.CHROMA_PORT ? Number(process.env.CHROMA_PORT) : 8000,
        });
  }
  return client;
}

/**
 * Gets (or creates) the collection of embedded station names/brands used for
 * semantic brand matching. In dev, requires a local Chroma server running —
 * start one with `npx chroma run` (see scripts/embed-stations.mjs). In
 * production, set CHROMA_API_KEY/CHROMA_TENANT/CHROMA_DATABASE to use
 * Chroma Cloud instead.
 */
export function getStationNamesCollection(): Promise<Collection> {
  if (!collectionPromise) {
    collectionPromise = getClient().getOrCreateCollection({
      name: STATION_NAMES_COLLECTION,
      embeddingFunction,
    });
  }
  return collectionPromise;
}
