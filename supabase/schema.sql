-- Fuel Trader schema
-- Run this once in the Supabase SQL editor (or via `supabase db push`) before
-- running the ingestion script for the first time.

-- PostGIS gives us proper geospatial indexing for "stations near me" queries
-- instead of hand-rolled Haversine math.
create extension if not exists postgis;

create table if not exists stations (
  node_id text primary key, -- stable ID from the source feed; used for incremental upserts
  trading_name text not null,
  brand_name text,
  is_motorway_service_station boolean default false,
  is_supermarket_service_station boolean default false,
  public_phone_number text,
  temporary_closure boolean default false,
  permanent_closure boolean default false,
  permanent_closure_date date,

  -- Location
  postcode text,
  address_line_1 text,
  address_line_2 text,
  city text,
  county text,
  country text, -- normalized to 'England' | 'Scotland' | 'Wales' | 'Northern Ireland' | null at ingestion time
  latitude double precision,
  longitude double precision,
  geog geography(Point, 4326), -- derived from lat/long; this is what gets spatially indexed

  -- Fuel prices (pence per litre, matching the source feed's unit)
  price_e5 numeric(6,2),
  price_e10 numeric(6,2),
  price_b7_standard numeric(6,2), -- B7S
  price_b7_premium numeric(6,2), -- B7P
  price_b10 numeric(6,2),
  price_hvo numeric(6,2),
  price_updated_at timestamptz, -- most recent of any fuel grade's submission timestamp

  -- Opening hours, one JSON blob per day is simplest here since we mostly need
  -- "is it open at time X on day Y" rather than querying individual fields.
  opening_hours jsonb,

  -- Amenities
  has_adblue_pumps boolean default false,
  has_adblue_packaged boolean default false,
  has_lpg_pumps boolean default false,
  has_car_wash boolean default false,
  has_air_pump_or_screenwash boolean default false,
  has_water_filling boolean default false,
  has_24h_fuel boolean default false,
  has_customer_toilets boolean default false,

  row_hash text not null, -- hash of the source row; lets the ingestion script skip unchanged rows
  updated_at timestamptz not null default now()
);

-- Keep geog in sync with latitude/longitude automatically.
create or replace function stations_set_geog() returns trigger as $$
begin
  if new.latitude is not null and new.longitude is not null then
    new.geog := ST_SetSRID(ST_MakePoint(new.longitude, new.latitude), 4326)::geography;
  else
    new.geog := null;
  end if;
  return new;
end;
$$ language plpgsql;

drop trigger if exists trg_stations_set_geog on stations;
create trigger trg_stations_set_geog
  before insert or update on stations
  for each row execute function stations_set_geog();

-- Spatial index — this is what makes "stations within N miles" queries fast
-- even at tens of thousands of rows.
create index if not exists idx_stations_geog on stations using gist (geog);

-- Common filter/sort columns
create index if not exists idx_stations_brand on stations (brand_name);
create index if not exists idx_stations_country on stations (country);
create index if not exists idx_stations_e10 on stations (price_e10) where price_e10 is not null;
create index if not exists idx_stations_e5 on stations (price_e5) where price_e5 is not null;
create index if not exists idx_stations_b7s on stations (price_b7_standard) where price_b7_standard is not null;
create index if not exists idx_stations_b7p on stations (price_b7_premium) where price_b7_premium is not null;

-- Convenience function used by the API route: stations within a radius,
-- with distance in miles, cheapest by supplied fuel column first.
-- (Called from the app via Supabase's RPC endpoint: supabase.rpc('nearby_stations', {...}))
create or replace function nearby_stations(
  origin_lat double precision,
  origin_lng double precision,
  radius_miles double precision default 10,
  fuel_column text default 'price_e10',
  max_results int default 20,
  exclude_closed boolean default true
) returns table (
  node_id text,
  trading_name text,
  brand_name text,
  postcode text,
  address_line_1 text,
  city text,
  county text,
  country text,
  latitude double precision,
  longitude double precision,
  distance_miles double precision,
  price numeric,
  opening_hours jsonb,
  has_car_wash boolean,
  has_customer_toilets boolean,
  has_24h_fuel boolean,
  temporary_closure boolean
) as $$
begin
  return query execute format(
    'select node_id, trading_name, brand_name, postcode, address_line_1, city, county, country,
            latitude, longitude,
            ST_Distance(geog, ST_SetSRID(ST_MakePoint($2, $1), 4326)::geography) / 1609.34 as distance_miles,
            %I as price, opening_hours, has_car_wash, has_customer_toilets, has_24h_fuel, temporary_closure
     from stations
     where geog is not null
       and %I is not null
       and ($5 = false or temporary_closure = false)
       and ST_DWithin(geog, ST_SetSRID(ST_MakePoint($2, $1), 4326)::geography, $3 * 1609.34)
     order by %I asc
     limit $4',
    fuel_column, fuel_column, fuel_column
  ) using origin_lat, origin_lng, radius_miles, max_results, exclude_closed;
end;
$$ language plpgsql stable;
