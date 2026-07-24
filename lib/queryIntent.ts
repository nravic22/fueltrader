import { z } from 'zod';
import { generateObject } from 'ai';
import { anthropic } from '@ai-sdk/anthropic';

export const FUEL_COLUMN_MAP = {
  E5: 'price_e5',
  E10: 'price_e10',
  B7_STANDARD: 'price_b7_standard',
  B7_PREMIUM: 'price_b7_premium',
  B10: 'price_b10',
  HVO: 'price_hvo',
} as const;

export type FuelType = keyof typeof FUEL_COLUMN_MAP;

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
    .describe('A place name or postcode mentioned in the query to search near, e.g. "Bolton" or "NP4 6JU". Null if the visitor\'s own GPS location should be used instead, or if no location is relevant.'),
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
});

export type QueryIntent = z.infer<typeof QueryIntentSchema>;

export async function parseQueryIntent(userQuery: string, hasGpsLocation: boolean): Promise<QueryIntent> {
  const now = new Date();
  const ukTimeString = now.toLocaleString('en-GB', { timeZone: 'Europe/London' });

  const { object } = await generateObject({
    model: anthropic('claude-haiku-4-5-20251001'), // fast + cheap; this is a structured extraction task, not open-ended generation
    schema: QueryIntentSchema,
    system: `You convert a visitor's natural-language question about UK fuel stations into structured search parameters. 
Current UK time: ${ukTimeString}.
The visitor ${hasGpsLocation ? 'HAS' : 'has NOT'} shared their GPS location.
Only extract what the question actually asks for — don't assume a fuel type, brand, or amenity that wasn't mentioned.
If the question is about "near me" / "nearby" / distance without naming a place, and the visitor has shared GPS, set needs_location=true and location_text=null (their GPS will be used).
If the question names a specific place/postcode to search near, set location_text to that place instead.`,
    prompt: userQuery,
  });

  return object;
}
