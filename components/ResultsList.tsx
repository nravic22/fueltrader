'use client';

import type { StationResult } from '@/lib/queryBuilder';

interface ResultsListProps {
  stations: StationResult[];
  selectedStationId: string | null;
  onSelectStation: (nodeId: string) => void;
}

export default function ResultsList({ stations, selectedStationId, onSelectStation }: ResultsListProps) {
  if (stations.length === 0) {
    return <div className="empty-state">Ask a question above to see nearby stations and prices here.</div>;
  }

  return (
    <>
      {stations.map((station) => (
        <div
          key={station.node_id}
          className={`station-card ${station.node_id === selectedStationId ? 'is-selected' : ''}`}
          onClick={() => onSelectStation(station.node_id)}
          role="button"
          tabIndex={0}
          onKeyDown={(e) => {
            if (e.key === 'Enter') onSelectStation(station.node_id);
          }}
        >
          <div className="station-card-main">
            <p className="station-name">{station.trading_name}</p>
            <p className="station-meta">
              {station.brand_name ? `${station.brand_name} · ` : ''}
              {station.address_line_1 ? `${station.address_line_1}, ` : ''}
              {station.city ?? station.county ?? ''}
              {station.distance_miles != null ? ` · ${station.distance_miles.toFixed(1)} mi` : ''}
              {station.route_position_miles != null ? ` · ${station.route_position_miles.toFixed(0)} mi into trip` : ''}
            </p>
            <div className="station-badges">
              <span className={`badge ${station.is_open_now ? 'is-open' : ''}`}>
                {station.is_open_now ? 'Open now' : 'Closed now'}
              </span>
              {station.has_24h_fuel && <span className="badge">24hr fuel</span>}
              {station.has_car_wash && <span className="badge">Car wash</span>}
              {station.has_customer_toilets && <span className="badge">Toilets</span>}
              {station.matched_via_semantic && <span className="badge">🔍 Similar name</span>}
            </div>
          </div>

          {station.price != null && (
            <div className="price-board">
              <div className="fuel-label">{station.fuel_label}</div>
              <div className="value">{station.price.toFixed(1)}</div>
              <div className="unit">p / litre</div>
            </div>
          )}
        </div>
      ))}
    </>
  );
}
