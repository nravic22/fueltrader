export interface DrivingRoute {
  coordinates: [number, number][]; // [lng, lat], as returned by OSRM
  distanceMeters: number;
  durationSeconds: number;
}

export interface RouteSamplePoint {
  lat: number;
  lng: number;
  positionMiles: number; // distance from the route's start, along the route
}

const METERS_PER_MILE = 1609.344;

/**
 * Fetches a driving route between two points from OSRM's free public demo
 * server (no API key). Not meant for high-volume production traffic, but
 * fine at this app's scale — same tradeoff as the free Nominatim geocoder.
 */
export async function getDrivingRoute(
  origin: { lat: number; lng: number },
  destination: { lat: number; lng: number }
): Promise<DrivingRoute | null> {
  const url = `https://router.project-osrm.org/route/v1/driving/${origin.lng},${origin.lat};${destination.lng},${destination.lat}?overview=full&geometries=geojson`;

  const res = await fetch(url, {
    headers: { 'User-Agent': 'fuel-trader-app (contact: set-your-contact-email-here)' },
  });
  if (!res.ok) return null;

  const data = (await res.json()) as {
    code: string;
    routes?: Array<{ geometry: { coordinates: [number, number][] }; distance: number; duration: number }>;
  };
  if (data.code !== 'Ok' || !data.routes?.length) return null;

  const route = data.routes[0];
  return {
    coordinates: route.geometry.coordinates,
    distanceMeters: route.distance,
    durationSeconds: route.duration,
  };
}

function haversineMiles(a: [number, number], b: [number, number]): number {
  const R = 3958.8; // Earth radius in miles
  const [lng1, lat1] = a;
  const [lng2, lat2] = b;
  const dLat = ((lat2 - lat1) * Math.PI) / 180;
  const dLng = ((lng2 - lng1) * Math.PI) / 180;
  const h =
    Math.sin(dLat / 2) ** 2 + Math.cos((lat1 * Math.PI) / 180) * Math.cos((lat2 * Math.PI) / 180) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

/**
 * Picks evenly-spaced points along a route polyline (by distance, not vertex
 * count) so we can run a "nearby stations" search around each one and stitch
 * the results into an along-the-route search. Sample count is clamped so a
 * short hop doesn't over-query and a long trip doesn't under-sample.
 */
export function sampleRoutePoints(coordinates: [number, number][], totalMiles: number): RouteSamplePoint[] {
  if (coordinates.length === 0) return [];

  const desiredSamples = Math.min(15, Math.max(3, Math.round(totalMiles / 8)));
  const interval = totalMiles / (desiredSamples - 1 || 1);

  const samples: RouteSamplePoint[] = [];
  let cumulative = 0;
  let nextTarget = 0;
  let segmentIndex = 0;

  samples.push({ lat: coordinates[0][1], lng: coordinates[0][0], positionMiles: 0 });
  nextTarget = interval;

  while (segmentIndex < coordinates.length - 1 && samples.length < desiredSamples) {
    const segStart = coordinates[segmentIndex];
    const segEnd = coordinates[segmentIndex + 1];
    const segLength = haversineMiles(segStart, segEnd);

    if (cumulative + segLength >= nextTarget) {
      const t = segLength === 0 ? 0 : (nextTarget - cumulative) / segLength;
      const lng = segStart[0] + (segEnd[0] - segStart[0]) * t;
      const lat = segStart[1] + (segEnd[1] - segStart[1]) * t;
      samples.push({ lat, lng, positionMiles: nextTarget });
      nextTarget += interval;
    } else {
      cumulative += segLength;
      segmentIndex++;
    }
  }

  const last = coordinates[coordinates.length - 1];
  if (samples[samples.length - 1]?.positionMiles < totalMiles - 1) {
    samples.push({ lat: last[1], lng: last[0], positionMiles: totalMiles });
  }

  return samples;
}

export function metersToMiles(meters: number): number {
  return meters / METERS_PER_MILE;
}
