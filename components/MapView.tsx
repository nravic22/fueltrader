'use client';

import { useEffect, useRef, useState } from 'react';
import maplibregl, { Map as MapLibreMap, Marker } from 'maplibre-gl';
import 'maplibre-gl/dist/maplibre-gl.css';
import type { StationResult } from '@/lib/queryBuilder';

// Free, unlimited, no-API-key vector tiles — see OpenFreeMap.org.
const MAP_STYLE = 'https://tiles.openfreemap.org/styles/bright';

interface MapViewProps {
  stations: StationResult[];
  userLocation: { lat: number; lng: number } | null;
  selectedStationId: string | null;
  onSelectStation: (nodeId: string) => void;
}

export default function MapView({ stations, userLocation, selectedStationId, onSelectStation }: MapViewProps) {
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

  // Sync station markers whenever results change.
  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;

    for (const marker of markersRef.current.values()) marker.remove();
    markersRef.current.clear();

    if (stations.length === 0) return;

    const bounds = new maplibregl.LngLatBounds();

    for (const station of stations) {
      const el = document.createElement('div');
      el.style.width = '16px';
      el.style.height = '16px';
      el.style.borderRadius = '50%';
      el.style.background = station.node_id === selectedStationId ? '#ffb000' : '#0b4f6c';
      el.style.border = '2px solid white';
      el.style.boxShadow = '0 1px 3px rgba(0,0,0,0.4)';
      el.style.cursor = 'pointer';

      const marker = new maplibregl.Marker({ element: el })
        .setLngLat([station.longitude, station.latitude])
        .setPopup(
          new maplibregl.Popup({ offset: 12 }).setHTML(
            `<strong>${escapeHtml(station.trading_name)}</strong><br/>${station.price != null ? `${station.price.toFixed(1)}p/L` : ''}`
          )
        )
        .addTo(map);

      el.addEventListener('click', () => onSelectStation(station.node_id));

      markersRef.current.set(station.node_id, marker);
      bounds.extend([station.longitude, station.latitude]);
    }

    if (userLocation) bounds.extend([userLocation.lng, userLocation.lat]);
    map.fitBounds(bounds, { padding: 60, maxZoom: 14, duration: 600 });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [stations, selectedStationId]);

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

  // Pan to a station when its card is selected from the list.
  useEffect(() => {
    if (!selectedStationId) return;
    const station = stations.find((s) => s.node_id === selectedStationId);
    if (station && mapRef.current) {
      mapRef.current.easeTo({ center: [station.longitude, station.latitude], zoom: Math.max(mapRef.current.getZoom(), 13) });
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
