'use client';

import { useState } from 'react';
import QueryBar from '@/components/QueryBar';
import MapView, { type RouteInfo } from '@/components/MapView';
import ResultsList from '@/components/ResultsList';
import type { StationResult } from '@/lib/queryBuilder';

type LocationStatus = 'idle' | 'requesting' | 'granted' | 'denied';
type MobileTab = 'map' | 'answers';

export default function HomePage() {
  const [results, setResults] = useState<StationResult[]>([]);
  const [answer, setAnswer] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [selectedStationId, setSelectedStationId] = useState<string | null>(null);
  const [userLocation, setUserLocation] = useState<{ lat: number; lng: number } | null>(null);
  const [locationStatus, setLocationStatus] = useState<LocationStatus>('idle');
  const [mobileTab, setMobileTab] = useState<MobileTab>('map');
  const [route, setRoute] = useState<RouteInfo | null>(null);

  function requestLocation() {
    if (!navigator.geolocation) {
      setLocationStatus('denied');
      return;
    }
    setLocationStatus('requesting');
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        setUserLocation({ lat: pos.coords.latitude, lng: pos.coords.longitude });
        setLocationStatus('granted');
      },
      () => setLocationStatus('denied'),
      { enableHighAccuracy: false, timeout: 8000 }
    );
  }

  async function handleSubmit(query: string) {
    setLoading(true);
    setError(null);
    setAnswer(null);

    try {
      const res = await fetch('/api/query', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ query, userLocation }),
      });
      const data = await res.json();

      if (!res.ok) {
        setError(data.error ?? 'Something went wrong.');
        if (data.needsLocation) requestLocation();
        return;
      }

      setResults(data.results ?? []);
      setAnswer(data.answer ?? null);
      setSelectedStationId(data.results?.[0]?.node_id ?? null);
      setRoute(data.route ?? null);
    } catch (err) {
      setError('Could not reach the server — please try again.');
    } finally {
      setLoading(false);
      setMobileTab('answers');
    }
  }

  return (
    <div className="app-shell" data-mobile-tab={mobileTab}>
      <header className="app-header">
        <h1>⛽ Fuel Trader</h1>
        <p>Ask a question, see the cheapest fuel nearby — updated continuously.</p>
      </header>

      <div className="mobile-tabs">
        <button
          type="button"
          className={`mobile-tab-btn ${mobileTab === 'map' ? 'is-active' : ''}`}
          onClick={() => setMobileTab('map')}
        >
          🗺️ Map
        </button>
        <button
          type="button"
          className={`mobile-tab-btn ${mobileTab === 'answers' ? 'is-active' : ''}`}
          onClick={() => setMobileTab('answers')}
        >
          📋 Results
        </button>
      </div>

      <div className="main-grid">
        <MapView
          stations={results}
          userLocation={userLocation}
          selectedStationId={selectedStationId}
          onSelectStation={setSelectedStationId}
          route={route}
        />

        <div className="query-pane">
          <QueryBar
            onSubmit={handleSubmit}
            loading={loading}
            onRequestLocation={requestLocation}
            locationStatus={locationStatus}
          />
        </div>

        <div className="answers-pane">
          {error && <div className="error-card">{error}</div>}
          {answer && !error && <div className="answer-card">{answer}</div>}

          <ResultsList stations={results} selectedStationId={selectedStationId} onSelectStation={setSelectedStationId} />
        </div>
      </div>
    </div>
  );
}
