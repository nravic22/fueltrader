#!/usr/bin/env node
/**
 * Ingests the fuel price CSV feed into Supabase.
 *
 * Usage:
 *   node scripts/ingest.mjs --file ./data/sample-fuel-prices.csv
 *   node scripts/ingest.mjs --url https://example.com/latest-fuel-prices.csv
 *
 * Requires env vars: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY
 * (the service role key is required, not the anon key, since this writes data
 * and should never run in the browser — only in CI/the GitHub Action).
 *
 * Incremental sync: each row gets hashed; only rows whose hash changed since
 * the last run are re-upserted, and node_ids present in Supabase but absent
 * from the new CSV are marked as removed (rather than deleted outright, so a
 * one-off bad/truncated feed doesn't silently wipe the whole dataset).
 */

import { createClient } from '@supabase/supabase-js';
import { parse } from 'csv-parse/sync';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';

const args = parseArgs(process.argv.slice(2));

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
  console.error('Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY environment variables.');
  process.exit(1);
}

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

async function main() {
  const csvText = args.url ? await fetchText(args.url) : readFileSync(args.file, 'utf8');
  const rawRows = parse(csvText, { columns: true, skip_empty_lines: true, relax_column_count: true });

  console.log(`Parsed ${rawRows.length} rows from source.`);

  const stations = rawRows.map(normalizeRow).filter(Boolean);
  console.log(`Normalized ${stations.length} valid station rows.`);

  // Fetch existing hashes so we only write what actually changed.
  const { data: existing, error: fetchErr } = await supabase
    .from('stations')
    .select('node_id, row_hash');
  if (fetchErr) throw fetchErr;

  const existingHashes = new Map((existing ?? []).map((r) => [r.node_id, r.row_hash]));
  const incomingIds = new Set(stations.map((s) => s.node_id));

  const toUpsert = stations.filter((s) => existingHashes.get(s.node_id) !== s.row_hash);
  const removedIds = [...existingHashes.keys()].filter((id) => !incomingIds.has(id));

  console.log(`${toUpsert.length} rows changed/new, ${removedIds.length} rows no longer in feed.`);

  // Upsert in batches to stay well under request size limits.
  const BATCH_SIZE = 500;
  for (let i = 0; i < toUpsert.length; i += BATCH_SIZE) {
    const batch = toUpsert.slice(i, i + BATCH_SIZE);
    const { error } = await supabase.from('stations').upsert(batch, { onConflict: 'node_id' });
    if (error) throw error;
    console.log(`Upserted batch ${i / BATCH_SIZE + 1} (${batch.length} rows).`);
  }

  // Rows no longer present in the feed: mark temporarily closed rather than
  // deleting outright, so a bad/partial upstream fetch can't silently erase
  // stations that are actually still open.
  if (removedIds.length > 0) {
    const { error } = await supabase
      .from('stations')
      .update({ temporary_closure: true })
      .in('node_id', removedIds);
    if (error) throw error;
    console.log(`Flagged ${removedIds.length} missing-from-feed stations as temporarily closed.`);
  }

  console.log('Ingestion complete.');
}

function normalizeRow(row) {
  const nodeId = row['forecourts.node_id'];
  if (!nodeId) return null;

  const lat = toFloat(row['forecourts.location.latitude']);
  const lng = toFloat(row['forecourts.location.longitude']);

  const priceFields = {
    price_e5: toPrice(row['forecourts.fuel_price.E5']),
    price_e10: toPrice(row['forecourts.fuel_price.E10']),
    price_b7_standard: toPrice(row['forecourts.fuel_price.B7S']),
    price_b7_premium: toPrice(row['forecourts.fuel_price.B7P']),
    price_b10: toPrice(row['forecourts.fuel_price.B10']),
    price_hvo: toPrice(row['forecourts.fuel_price.HVO']),
  };

  const priceTimestamps = [
    row['forecourts.price_submission_timestamp.E5'],
    row['forecourts.price_submission_timestamp.E10'],
    row['forecourts.price_submission_timestamp.B7S'],
    row['forecourts.price_submission_timestamp.B7P'],
    row['forecourts.price_submission_timestamp.B10'],
    row['forecourts.price_submission_timestamp.HVO'],
  ]
    .map(toDate)
    .filter(Boolean);
  const priceUpdatedAt = priceTimestamps.length
    ? new Date(Math.max(...priceTimestamps.map((d) => d.getTime()))).toISOString()
    : null;

  const station = {
    node_id: nodeId,
    trading_name: row['forecourts.trading_name'] || 'Unknown',
    brand_name: row['forecourts.brand_name'] || null,
    is_motorway_service_station: toBool(row['forecourts.is_motorway_service_station']),
    is_supermarket_service_station: toBool(row['forecourts.is_supermarket_service_station']),
    public_phone_number: row['forecourts.public_phone_number'] || null,
    temporary_closure: toBool(row['forecourts.temporary_closure']),
    permanent_closure: toBool(row['forecourts.permanent_closure']),
    permanent_closure_date: row['forecourts.location.permanent_closure_date'] || null,

    postcode: row['forecourts.location.postcode'] || null,
    address_line_1: row['forecourts.location.address_line_1'] || null,
    address_line_2: row['forecourts.location.address_line_2'] || null,
    city: row['forecourts.location.city'] || null,
    county: row['forecourts.location.county'] || null,
    country: normalizeCountry(row['forecourts.location.country']),
    latitude: lat,
    longitude: lng,

    ...priceFields,
    price_updated_at: priceUpdatedAt,

    opening_hours: buildOpeningHours(row),

    has_adblue_pumps: toBool(row['forecourts.amenities.fuel_and_energy_services.adblue_pumps']),
    has_adblue_packaged: toBool(row['forecourts.amenities.fuel_and_energy_services.adblue_packaged']),
    has_lpg_pumps: toBool(row['forecourts.amenities.fuel_and_energy_services.lpg_pumps']),
    has_car_wash: toBool(row['forecourts.amenities.vehicle_services.car_wash']),
    has_air_pump_or_screenwash: toBool(row['forecourts.amenities.air_pump_or_screenwash']),
    has_water_filling: toBool(row['forecourts.amenities.water_filling']),
    has_24h_fuel: toBool(row['forecourts.amenities.twenty_four_hour_fuel']),
    has_customer_toilets: toBool(row['forecourts.amenities.customer_toilets']),
  };

  station.row_hash = hashRow(station);
  return station;
}

// The source feed uses wildly inconsistent country values (WALES / Wales / W /
// UNITED KINGDOM / UK / blank / single letters). Normalize to four canonical
// values so country-based filtering in the query layer actually works.
function normalizeCountry(raw) {
  if (!raw) return null;
  const v = raw.trim().toLowerCase();
  if (['england', 'e'].includes(v)) return 'England';
  if (['scotland', 's'].includes(v)) return 'Scotland';
  if (['wales', 'w'].includes(v)) return 'Wales';
  if (['northern ireland', 'n', 'ni'].includes(v)) return 'Northern Ireland';
  if (['united kingdom', 'uk'].includes(v)) return null; // too vague to map to one nation
  return null;
}

function buildOpeningHours(row) {
  const days = ['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday'];
  const hours = {};
  for (const day of days) {
    hours[day] = {
      open: row[`forecourts.opening_times.usual_days.${day}.open_time`] || null,
      close: row[`forecourts.opening_times.usual_days.${day}.close_time`] || null,
      is_24h: toBool(row[`forecourts.opening_times.usual_days.${day}.is_24_hours`]),
    };
  }
  hours.bank_holiday = {
    open: row['forecourts.opening_times.bank_holiday.standard.open_time'] || null,
    close: row['forecourts.opening_times.bank_holiday.standard.close_time'] || null,
    is_24h: toBool(row['forecourts.opening_times.bank_holiday.standard.is_24_hours']),
  };
  return hours;
}

function hashRow(station) {
  // Exclude fields that shouldn't trigger a "changed" re-embed/write on their
  // own noise (there are none here currently, but keeping this explicit).
  const { row_hash, ...rest } = station;
  return createHash('sha256').update(JSON.stringify(rest)).digest('hex');
}

function toBool(v) {
  return String(v).trim().toLowerCase() === 'true';
}

function toFloat(v) {
  const n = parseFloat(v);
  return Number.isFinite(n) ? n : null;
}

function toPrice(v) {
  if (!v || !String(v).trim()) return null;
  const n = parseFloat(v);
  return Number.isFinite(n) ? n : null;
}

function toDate(v) {
  if (!v) return null;
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? null : d;
}

async function fetchText(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Failed to fetch CSV from ${url}: ${res.status} ${res.statusText}`);
  return res.text();
}

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--file') out.file = argv[++i];
    if (argv[i] === '--url') out.url = argv[++i];
  }
  if (!out.file && !out.url) {
    console.error('Usage: node scripts/ingest.mjs --file <path> | --url <url>');
    process.exit(1);
  }
  return out;
}

main().catch((err) => {
  console.error('Ingestion failed:', err);
  process.exit(1);
});
