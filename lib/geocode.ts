/**
 * Resolves a free-text location (postcode, town name, etc.) to coordinates
 * using Nominatim, OpenStreetMap's free geocoding service.
 *
 * Nominatim's usage policy caps public API use at ~1 request/second and asks
 * for a descriptive User-Agent — fine for this project's expected traffic,
 * but if this app ever needs high query volume, swap in a paid geocoder
 * (e.g. Geoapify, LocationIQ) using the same function signature.
 */
export async function geocode(query: string): Promise<{ lat: number; lng: number } | null> {
  const url = new URL('https://nominatim.openstreetmap.org/search');
  url.searchParams.set('q', `${query}, UK`);
  url.searchParams.set('format', 'json');
  url.searchParams.set('limit', '1');
  url.searchParams.set('countrycodes', 'gb');

  const res = await fetch(url.toString(), {
    headers: {
      // Required by Nominatim's usage policy — identifies the app, not a
      // secret, safe to leave as a literal string.
      'User-Agent': 'fuel-trader-app (contact: set-your-contact-email-here)',
    },
  });

  if (!res.ok) return null;

  const results = (await res.json()) as Array<{ lat: string; lon: string }>;
  if (!results.length) return null;

  return { lat: parseFloat(results[0].lat), lng: parseFloat(results[0].lon) };
}
