import { getStationNamesCollection } from './chroma';

// Empirical cutoff for the default embedding model/distance metric — matches
// beyond this are unrelated noise, not genuine brand/name similarity.
const MAX_USEFUL_DISTANCE = 1.0;

/**
 * Resolves a (possibly misspelled/informal) brand or station name to node_ids
 * of semantically similar stations, via the local Chroma collection. Returns
 * an empty array (rather than throwing) if Chroma isn't reachable, since this
 * is a fuzzy-matching enhancement, not a required dependency — a query should
 * still work with plain substring matching if the local Chroma server isn't
 * running.
 */
export async function findSemanticBrandNodeIds(query: string, topK = 15): Promise<string[]> {
  try {
    const collection = await getStationNamesCollection();
    const result = await collection.query({ queryTexts: [query], nResults: topK });

    const ids = result.ids[0] ?? [];
    const distances = result.distances?.[0] ?? [];

    return ids.filter((_, i) => (distances[i] ?? Infinity) <= MAX_USEFUL_DISTANCE);
  } catch (err) {
    console.warn('Semantic brand search unavailable (is `npx chroma run` running?):', (err as Error).message);
    return [];
  }
}
