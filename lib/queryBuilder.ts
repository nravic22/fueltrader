import { getSupabaseClient } from './supabase';
import { FUEL_COLUMN_MAP, FUEL_TYPE_LABEL, type QueryIntent } from './queryIntent';
import { sampleRoutePoints, type DrivingRoute } from './route';
import { findSemanticBrandNodeIds } from './semanticSearch';

export interface StationResult {
  node_id: string;
  trading_name: string;
  brand_name: string | null;
  postcode: string | null;
  address_line_1: string | null;
  city: string | null;
  county: string | null;
  country: string | null;
  latitude: number;
  longitude: number;
  distance_miles: number | null;
  price: number | null;
  fuel_label: 'Unleaded' | 'Diesel';
  opening_hours: Record<string, { open: string | null; close: string | null; is_24h: boolean }>;
  has_car_wash: boolean;
  has_customer_toilets: boolean;
  has_24h_fuel: boolean;
  temporary_closure: boolean;
  is_open_now?: boolean;
  // Only set for route/trip queries: how far into the journey this station sits.
  route_position_miles?: number;
  // True when this result only matched the requested brand via semantic
  // name similarity (e.g. "Tesco" -> "TESCO SUPERSTORE"), not a literal substring.
  matched_via_semantic?: boolean;
}

const AMENITY_COLUMN_MAP: Record<string, string> = {
  car_wash: 'has_car_wash',
  customer_toilets: 'has_customer_toilets',
  twenty_four_hour_fuel: 'has_24h_fuel',
  lpg_pumps: 'has_lpg_pumps',
  adblue_pumps: 'has_adblue_pumps',
  adblue_packaged: 'has_adblue_packaged',
  water_filling: 'has_water_filling',
  air_pump_or_screenwash: 'has_air_pump_or_screenwash',
};

export async function runStationQuery(
  intent: QueryIntent,
  location: { lat: number; lng: number } | null
): Promise<StationResult[]> {
  const supabase = getSupabaseClient();
  const fuelColumn = intent.fuel_type ? FUEL_COLUMN_MAP[intent.fuel_type] : 'price_e10'; // default to E10 when unspecified, the most common UK petrol grade
  const fuelLabel = FUEL_TYPE_LABEL[intent.fuel_type ?? 'E10'];

  // Resolve fuzzy/informal brand names (e.g. "Tesco" -> "TESCO SUPERSTORE")
  // once, up front, via the local semantic-search index — used by whichever
  // branch below runs. Falls back to [] if Chroma isn't reachable.
  const semanticBrandIds = intent.brand_name ? await findSemanticBrandNodeIds(intent.brand_name) : [];

  let results: StationResult[];

  if (location) {
    // Location-based search: use the spatially-indexed RPC function so
    // "nearby" queries stay fast regardless of total table size.
    const { data, error } = await supabase.rpc('nearby_stations', {
      origin_lat: location.lat,
      origin_lng: location.lng,
      radius_miles: intent.radius_miles,
      fuel_column: fuelColumn,
      max_results: Math.min(intent.max_results * 3, 100), // over-fetch since amenity/open-now filtering happens after
      exclude_closed: true,
    });
    if (error) throw error;
    results = data as StationResult[];

    if (intent.sort_by === 'distance_asc') {
      results = results.slice().sort((a, b) => (a.distance_miles ?? 0) - (b.distance_miles ?? 0));
    }

    if (intent.brand_name) {
      results = applyBrandFilter(results, intent.brand_name, semanticBrandIds);
    }
  } else {
    // No location context (e.g. "which brands sell HVO") — plain filtered query.
    let query = supabase
      .from('stations')
      .select(
        'node_id, trading_name, brand_name, postcode, address_line_1, city, county, country, latitude, longitude, opening_hours, has_car_wash, has_customer_toilets, has_24h_fuel, temporary_closure, ' +
          fuelColumn
      )
      .not(fuelColumn, 'is', null)
      .eq('temporary_closure', false)
      .order(fuelColumn, { ascending: true })
      .limit(Math.min(intent.max_results * 3, 100));

    if (intent.brand_name) {
      // Match either a literal substring or a semantically-similar name, so
      // typos/informal brand names still surface results, without giving up
      // the DB-level filter (which lets this stay correctly sorted by price
      // across ALL matching stations, not just a pre-limited candidate set).
      const orParts = [`brand_name.ilike.%${intent.brand_name}%`];
      if (semanticBrandIds.length > 0) orParts.push(`node_id.in.(${semanticBrandIds.join(',')})`);
      query = query.or(orParts.join(','));
    }

    const { data, error } = await query;
    if (error) throw error;
    results = (data as any[]).map((r) => ({ ...r, price: r[fuelColumn], distance_miles: null }));

    if (intent.brand_name) {
      results = results.map((r) => ({
        ...r,
        matched_via_semantic: !r.brand_name?.toLowerCase().includes(intent.brand_name!.toLowerCase()),
      }));
    }
  }

  return finalizeResults(results, intent, fuelLabel).slice(0, intent.max_results);
}

/** Keeps a result if its brand literally contains the query, or if the semantic index flagged it as similar. */
function applyBrandFilter(results: StationResult[], brandName: string, semanticNodeIds: string[]): StationResult[] {
  const semanticSet = new Set(semanticNodeIds);
  const needle = brandName.toLowerCase();

  return results
    .filter((r) => r.brand_name?.toLowerCase().includes(needle) || semanticSet.has(r.node_id))
    .map((r) => ({ ...r, matched_via_semantic: !r.brand_name?.toLowerCase().includes(needle) }));
}

/**
 * Trip/route search: samples points along the driving route and runs the
 * same spatially-indexed "nearby" RPC around each one, so results are found
 * within a corridor of the actual road route rather than a straight line
 * between the two endpoints. Results are then merged, deduped, and ordered
 * start-to-end along the journey.
 */
export async function runRouteStationQuery(intent: QueryIntent, route: DrivingRoute): Promise<StationResult[]> {
  const supabase = getSupabaseClient();
  const fuelColumn = intent.fuel_type ? FUEL_COLUMN_MAP[intent.fuel_type] : 'price_e10';
  const fuelLabel = FUEL_TYPE_LABEL[intent.fuel_type ?? 'E10'];
  const totalMiles = route.distanceMeters / 1609.344;

  const samples = sampleRoutePoints(route.coordinates, totalMiles);

  // "all" mode caps how many stations each sample point can contribute, so a
  // dense cluster near the start (e.g. a big city) can't crowd out coverage
  // further along the route — every point gets a fair, small slice instead.
  // "cheapest_n" needs a wider pool per sample since it re-ranks globally by
  // price afterward and shouldn't miss the true cheapest just because it
  // wasn't in a sample's top few.
  const perSampleCap = intent.route_result_mode === 'cheapest_n' ? 20 : 8;

  const perSampleResults = await Promise.all(
    samples.map(async (sample) => {
      const { data, error } = await supabase.rpc('nearby_stations', {
        origin_lat: sample.lat,
        origin_lng: sample.lng,
        radius_miles: intent.radius_miles,
        fuel_column: fuelColumn,
        max_results: 20, // over-fetch from the RPC; perSampleCap below does the real capping
        exclude_closed: true,
      });
      if (error) throw error;
      return (data as StationResult[])
        .slice(0, perSampleCap) // RPC already sorts by price ascending, so this keeps each sample's cheapest
        .map((r) => ({ ...r, route_position_miles: sample.positionMiles }));
    })
  );

  // Merge + dedupe by node_id, keeping whichever sample point found the
  // station first (i.e. earliest point along the route).
  const byNodeId = new Map<string, StationResult>();
  for (const batch of perSampleResults) {
    for (const station of batch) {
      const existing = byNodeId.get(station.node_id);
      if (!existing || (station.route_position_miles ?? 0) < (existing.route_position_miles ?? 0)) {
        byNodeId.set(station.node_id, station);
      }
    }
  }

  let results = [...byNodeId.values()].sort((a, b) => (a.route_position_miles ?? 0) - (b.route_position_miles ?? 0));

  if (intent.brand_name) {
    const semanticBrandIds = await findSemanticBrandNodeIds(intent.brand_name);
    results = applyBrandFilter(results, intent.brand_name, semanticBrandIds);
  }

  // results is currently sorted start-to-end along the route (ascending
  // route_position_miles) — keep that order for "all" mode so pins actually
  // span the whole trip. For "cheapest_n", select the N cheapest from the
  // FULL route first, THEN re-sort those back into route order, so the list
  // still reads start-to-finish rather than purely by price.
  const finalized = finalizeResults(results, intent, fuelLabel);
  const ROUTE_ALL_SAFETY_CAP = 100; // just a sane ceiling against pathologically long routes, not a real limit

  if (intent.route_result_mode === 'cheapest_n') {
    return finalized
      .slice()
      .sort((a, b) => (a.price ?? Infinity) - (b.price ?? Infinity))
      .slice(0, intent.max_results)
      .sort((a, b) => (a.route_position_miles ?? 0) - (b.route_position_miles ?? 0));
  }

  return finalized.slice(0, ROUTE_ALL_SAFETY_CAP);
}

function finalizeResults(results: StationResult[], intent: QueryIntent, fuelLabel: 'Unleaded' | 'Diesel'): StationResult[] {
  for (const key of intent.amenities) {
    const column = AMENITY_COLUMN_MAP[key];
    if (column) {
      results = results.filter((r) => (r as any)[column] === true);
    }
  }

  if (intent.open_now) {
    results = results.filter((r) => isOpenNow(r.opening_hours));
  }

  return results.map((r) => ({
    ...r,
    fuel_label: fuelLabel,
    is_open_now: isOpenNow(r.opening_hours),
  }));
}

const DAY_NAMES = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];

function isOpenNow(openingHours: StationResult['opening_hours']): boolean {
  if (!openingHours) return false;

  const nowUk = new Date(new Date().toLocaleString('en-US', { timeZone: 'Europe/London' }));
  const dayName = DAY_NAMES[nowUk.getDay()];
  const today = openingHours[dayName];
  if (!today) return false;
  if (today.is_24h) return true;
  if (!today.open || !today.close) return false;

  const nowMinutes = nowUk.getHours() * 60 + nowUk.getMinutes();
  const [openH, openM] = today.open.split(':').map(Number);
  const [closeH, closeM] = today.close.split(':').map(Number);
  const openMinutes = openH * 60 + openM;
  let closeMinutes = closeH * 60 + closeM;
  if (closeMinutes === 0) closeMinutes = 24 * 60; // "00:00:00" close time means midnight/end of day

  return nowMinutes >= openMinutes && nowMinutes <= closeMinutes;
}
