'use client';

import { useEffect, useRef, useState } from 'react';
import maplibregl, { Map as MapLibreMap, Marker } from 'maplibre-gl';
import 'maplibre-gl/dist/maplibre-gl.css';
import type { StationResult } from '@/lib/queryBuilder';

// Free, unlimited, no-API-key vector tiles — see OpenFreeMap.org.
const MAP_STYLE = 'https://tiles.openfreemap.org/styles/bright';

// Material Symbols "local_gas_station" glyph, used inside each pin badge.
const FUEL_PUMP_ICON =
  '<svg viewBox="0 0 24 24" width="65%" height="65%" fill="white"><path d="M19.77 7.23l.01-.01-3.72-3.72L15 4.56l2.11 2.11c-.94.36-1.61 1.26-1.61 2.33 0 1.38 1.12 2.5 2.5 2.5.36 0 .69-.08 1-.21v7.21c0 .55-.45 1-1 1s-1-.45-1-1V14c0-1.1-.9-2-2-2h-1V5c0-1.1-.9-2-2-2H6c-1.1 0-2 .9-2 2v16h10v-7.5h1.5v5c0 1.38 1.12 2.5 2.5 2.5s2.5-1.12 2.5-2.5V9c0-.69-.28-1.32-.73-1.77zM12 9H6V5h6v4zm6 2c-.55 0-1-.45-1-1s.45-1 1-1 1 .45 1 1-.45 1-1 1z"/></svg>';

const ROUTE_SOURCE_ID = 'trip-route';

export interface RouteInfo {
  coordinates: [number, number][];
}

interface MapViewProps {
  stations: StationResult[];
  userLocation: { lat: number; lng: number } | null;
  selectedStationId: string | null;
  onSelectStation: (nodeId: string) => void;
  route?: RouteInfo | null;
}

export default function MapView({ stations, userLocation, selectedStationId, onSelectStation, route }: MapViewProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<MapLibreMap | null>(null);
  const markersRef = useRef<Map<string, Marker>>(new Map());
  const userMarkerRef = useRef<Marker | null>(null);
  const [isFullscreen, setIsFullscreen] = useState(false);

  // Initialize the map once.
  useEffect(() => {
    if (!containerRef.current || mapRef.current) return;

    mapRef.current = new maplibregl.Map({
      container: containerRef.current,
      style: MAP_STYLE,
      center: [-2.5, 54.0], // roughly the geographic center of the UK
      zoom: 5.2,
      attributionControl: { compact: true },
    });
    mapRef.current.addControl(new maplibregl.NavigationControl({ showCompass: false }), 'top-right');

    return () => {
      mapRef.current?.remove();
      mapRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Force MapLibre to recalculate its size when the fullscreen layout changes.
  useEffect(() => {
    const id = setTimeout(() => mapRef.current?.resize(), 200);
    return () => clearTimeout(id);
  }, [isFullscreen]);

  // Create/replace station markers whenever the result set changes, and fit
  // the map to show them all. Selection styling is handled by a separate
  // effect below so clicking a result doesn't re-trigger this fit-to-all.
  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;

    for (const marker of markersRef.current.values()) marker.remove();
    markersRef.current.clear();

    if (stations.length === 0) return;

    const bounds = new maplibregl.LngLatBounds();

    for (const station of stations) {
      const el = document.createElement('div');
      el.className = 'station-marker';
      el.style.width = '26px';
      el.style.height = '26px';
      el.style.display = 'flex';
      el.style.alignItems = 'center';
      el.style.justifyContent = 'center';
      el.style.borderRadius = '50%';
      el.style.background = '#0b4f6c';
      el.style.border = '2px solid white';
      el.style.boxShadow = '0 1px 3px rgba(0,0,0,0.4)';
      el.style.cursor = 'pointer';
      el.innerHTML = FUEL_PUMP_ICON;

      const marker = new maplibregl.Marker({ element: el })
        .setLngLat([station.longitude, station.latitude])
        .setPopup(
          new maplibregl.Popup({ offset: 12 }).setHTML(
            `<strong>${escapeHtml(station.trading_name)}</strong><br/>${station.price != null ? `${station.fuel_label} · ${station.price.toFixed(1)}p/L` : ''}`
          )
        )
        .addTo(map);

      el.addEventListener('click', () => onSelectStation(station.node_id));

      markersRef.current.set(station.node_id, marker);
      bounds.extend([station.longitude, station.latitude]);
    }

    if (userLocation) bounds.extend([userLocation.lng, userLocation.lat]);
    if (route) for (const coord of route.coordinates) bounds.extend(coord as [number, number]);
    map.fitBounds(bounds, { padding: 60, maxZoom: 14, duration: 600 });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [stations, route]);

  // Draw (or clear) the driving route line whenever it changes.
  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;

    const syncRouteLayer = () => {
      const existingSource = map.getSource(ROUTE_SOURCE_ID) as maplibregl.GeoJSONSource | undefined;

      if (!route) {
        if (map.getLayer(ROUTE_SOURCE_ID)) map.removeLayer(ROUTE_SOURCE_ID);
        if (existingSource) map.removeSource(ROUTE_SOURCE_ID);
        return;
      }

      const geojson = {
        type: 'Feature',
        properties: {},
        geometry: { type: 'LineString', coordinates: route.coordinates },
      };

      if (existingSource) {
        existingSource.setData(geojson as any);
      } else {
        map.addSource(ROUTE_SOURCE_ID, { type: 'geojson', data: geojson as any });
        map.addLayer({
          id: ROUTE_SOURCE_ID,
          type: 'line',
          source: ROUTE_SOURCE_ID,
          layout: { 'line-join': 'round', 'line-cap': 'round' },
          paint: { 'line-color': '#1a73e8', 'line-width': 5, 'line-opacity': 0.8 },
        });
      }
    };

    if (map.isStyleLoaded()) syncRouteLayer();
    else map.once('load', syncRouteLayer);
  }, [route]);

  // Style + open the popup for whichever marker is currently selected, and
  // reset the rest — no map movement or marker recreation here, just the
  // "which pin is focused" visual state.
  useEffect(() => {
    for (const [nodeId, marker] of markersRef.current) {
      const el = marker.getElement();
      const isSelected = nodeId === selectedStationId;
      el.style.width = isSelected ? '34px' : '26px';
      el.style.height = isSelected ? '34px' : '26px';
      el.style.background = isSelected ? '#ffb000' : '#0b4f6c';
      el.style.zIndex = isSelected ? '10' : '0';

      const popup = marker.getPopup();
      if (isSelected) {
        if (popup && !popup.isOpen()) marker.togglePopup();
      } else if (popup?.isOpen()) {
        marker.togglePopup();
      }
    }
  }, [selectedStationId, stations]);

  // User's own location marker (distinct blue dot).
  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;

    userMarkerRef.current?.remove();
    userMarkerRef.current = null;

    if (userLocation) {
      const el = document.createElement('div');
      el.style.width = '18px';
      el.style.height = '18px';
      el.style.borderRadius = '50%';
      el.style.background = '#1a73e8';
      el.style.border = '3px solid white';
      el.style.boxShadow = '0 0 0 4px rgba(26,115,232,0.25)';

      userMarkerRef.current = new maplibregl.Marker({ element: el }).setLngLat([userLocation.lng, userLocation.lat]).addTo(map);
    }
  }, [userLocation]);

  // When a card is selected from the list, keep the overview zoom level —
  // only pan (never zoom in) if its pin isn't already visible in the current
  // viewport, so selecting a result doesn't disrupt the "see everything" view.
  useEffect(() => {
    if (!selectedStationId) return;
    const map = mapRef.current;
    const station = stations.find((s) => s.node_id === selectedStationId);
    if (!station || !map) return;

    const lngLat: [number, number] = [station.longitude, station.latitude];
    if (!map.getBounds().contains(lngLat)) {
      map.easeTo({ center: lngLat });
    }
  }, [selectedStationId, stations]);

  return (
    <div className={`map-column ${isFullscreen ? 'is-fullscreen' : ''}`}>
      <div ref={containerRef} style={{ width: '100%', height: '100%' }} />
      <button
        type="button"
        onClick={() => setIsFullscreen((v) => !v)}
        aria-label={isFullscreen ? 'Exit fullscreen map' : 'View map fullscreen'}
        style={{
          position: 'absolute',
          top: 10,
          left: 10,
          zIndex: 10,
          background: 'white',
          border: '1px solid #dfe6e8',
          borderRadius: 8,
          width: 36,
          height: 36,
          cursor: 'pointer',
          fontSize: 16,
        }}
      >
        {isFullscreen ? '✕' : '⤢'}
      </button>
    </div>
  );
}

function escapeHtml(s: string) {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));
}
