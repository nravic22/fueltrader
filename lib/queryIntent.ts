import { z } from 'zod';
import { generateObject } from 'ai';
import { getLLMModel } from '@/lib/llm';

export const FUEL_COLUMN_MAP = {
  E5: 'price_e5',
  E10: 'price_e10',
  B7_STANDARD: 'price_b7_standard',
  B7_PREMIUM: 'price_b7_premium',
  B10: 'price_b10',
  HVO: 'price_hvo',
} as const;

export type FuelType = keyof typeof FUEL_COLUMN_MAP;

// E5/E10 are unleaded petrol grades; B7/B10/HVO are diesel/biodiesel grades.
// The UK hasn't sold leaded fuel since 2000, so "Unleaded" here just means petrol.
export const FUEL_TYPE_LABEL: Record<FuelType, 'Unleaded' | 'Diesel'> = {
  E5: 'Unleaded',
  E10: 'Unleaded',
  B7_STANDARD: 'Diesel',
  B7_PREMIUM: 'Diesel',
  B10: 'Diesel',
  HVO: 'Diesel',
};

const AMENITY_KEYS = [
  'car_wash',
  'customer_toilets',
  'twenty_four_hour_fuel',
  'lpg_pumps',
  'adblue_pumps',
  'adblue_packaged',
  'water_filling',
  'air_pump_or_screenwash',
] as const;

export const QueryIntentSchema = z.object({
  needs_location: z
    .boolean()
    .describe('True if answering this question requires knowing the visitor\'s location (e.g. "near me", "nearby", distance-based questions).'),
  location_text: z
    .string()
    .nullable()
    .describe(
      'A place name or postcode mentioned in the query to search near, e.g. "Bolton" or "NP4 6JU". ' +
        'For a planned trip/route query (e.g. "driving from Manchester to Leeds"), this is the trip\'s START/origin place. ' +
        'Null if the visitor\'s own GPS location should be used instead, or if no location is relevant.'
    ),
  destination_text: z
    .string()
    .nullable()
    .describe(
      'Only set for a planned trip/route query that names both a start and an end place (e.g. "from Manchester to Leeds", ' +
        '"driving to London, need to fill up on the way", "route from X to Y"). This is the trip\'s END/destination place. ' +
        'Null for any query that is not an A-to-B route (e.g. plain "near me" or "near <place>" searches).'
    ),
  fuel_type: z
    .enum(['E5', 'E10', 'B7_STANDARD', 'B7_PREMIUM', 'B10', 'HVO'])
    .nullable()
    .describe('The fuel grade the question is about. B7_STANDARD is regular diesel, B7_PREMIUM is premium diesel. Null if not specified or not relevant.'),
  radius_miles: z.number().min(0.5).max(100).default(10).describe('Search radius in miles. Default 10 if not specified.'),
  sort_by: z.enum(['price_asc', 'distance_asc']).describe('Whether to rank results by cheapest price or by nearest distance.'),
  brand_name: z.string().nullable().describe('A specific fuel brand mentioned, e.g. "Tesco", "Shell". Null if not specified.'),
  amenities: z.array(z.enum(AMENITY_KEYS)).describe('Any amenities the visitor asked for, mapped to these known keys. Empty array if none.'),
  open_now: z.boolean().describe('True if the visitor is asking about currently-open stations.'),
  max_results: z.number().min(1).max(50).default(10).describe('How many results to return. Default 10.'),
  route_result_mode: z
    .enum(['all', 'cheapest_n'])
    .nullable()
    .describe(
      'Only relevant for a route/trip query (destination_text is set). "cheapest_n" if the visitor asked to limit results to ' +
        'their N cheapest options (e.g. "top 5 cheapest on the way", "just show me 10 options", "the 3 best stops") — set ' +
        'max_results to that N. "all" (the default when not specified) shows every station found along the whole route, ' +
        'start to finish, not just a capped number near the start. Null for non-route queries.'
    ),
});

export type QueryIntent = z.infer<typeof QueryIntentSchema>;

export async function parseQueryIntent(userQuery: string, hasGpsLocation: boolean): Promise<QueryIntent> {
  const now = new Date();
  const ukTimeString = now.toLocaleString('en-GB', { timeZone: 'Europe/London' });

  const { object } = await generateObject({
    model: getLLMModel(),
    schema: QueryIntentSchema,
    maxTokens: 500, // the schema is small; this just bounds worst-case output, not a real constraint
    system: `You convert a visitor's natural-language question about UK fuel stations into structured search parameters.
Current UK time: ${ukTimeString}.
The visitor ${hasGpsLocation ? 'HAS' : 'has NOT'} shared their GPS location.
Only extract what the question actually asks for — don't assume a fuel type, brand, or amenity that wasn't mentioned.
If the question is about "near me" / "nearby" / distance without naming a place, and the visitor has shared GPS, set needs_location=true and location_text=null (their GPS will be used).
If the question names a specific place/postcode to search near, set location_text to that place instead.

Watch for UK place names that are also ordinary English words (e.g. "Reading", "Bath", "Looe", "Wells", "Ryde") — a phrase like "in Reading" or "diesel in Bath" means the TOWN, not the verb/noun. If a capitalized word appears right after "in"/"near"/"at"/"around" and the sentence would otherwise be about finding fuel somewhere, treat it as a place name and set location_text to it, even if that word also has an unrelated everyday meaning.

If the question describes a planned trip/drive between two named places (e.g. "driving from Manchester to Leeds, where should I fill up", "route from X to Y", "on the way from A to B"), treat it as a route query:
- Set location_text to the start place and destination_text to the end place.
- Set needs_location=false (a route query never relies on GPS).
- Default radius_miles to about 5 (a tight corridor either side of the route) unless the visitor asks for a different distance.
- Default route_result_mode to "all" so the whole route gets covered, UNLESS the visitor explicitly asks to limit the count
  (words like "top", "cheapest N", "just show me N", "best N stops") — then set route_result_mode="cheapest_n" and set
  max_results to that N.
For any query that is NOT a two-place route, always leave destination_text and route_result_mode null.`,
    prompt: userQuery,
  });

  return object;
}
