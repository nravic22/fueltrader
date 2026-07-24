import { getSupabaseClient } from './supabase';
import { FUEL_COLUMN_MAP, type QueryIntent } from './queryIntent';

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
  opening_hours: Record<string, { open: string | null; close: string | null; is_24h: boolean }>;
  has_car_wash: boolean;
  has_customer_toilets: boolean;
  has_24h_fuel: boolean;
  temporary_closure: boolean;
  is_open_now?: boolean;
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
      query = query.ilike('brand_name', `%${intent.brand_name}%`);
    }

    const { data, error } = await query;
    if (error) throw error;
    results = (data as any[]).map((r) => ({ ...r, price: r[fuelColumn], distance_miles: null }));
  }

  if (intent.brand_name && location) {
    results = results.filter((r) => r.brand_name?.toLowerCase().includes(intent.brand_name!.toLowerCase()));
  }

  for (const key of intent.amenities) {
    const column = AMENITY_COLUMN_MAP[key];
    if (column) {
      results = results.filter((r) => (r as any)[column] === true);
    }
  }

  if (intent.open_now) {
    results = results.filter((r) => isOpenNow(r.opening_hours));
  }

  return results.slice(0, intent.max_results).map((r) => ({
    ...r,
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
