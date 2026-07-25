'use client';

import { useEffect, useRef, useState } from 'react';

interface QueryBarProps {
  onSubmit: (query: string) => void;
  loading: boolean;
  onRequestLocation: () => void;
  locationStatus: 'idle' | 'requesting' | 'granted' | 'denied';
}

// Web Speech API isn't in TypeScript's default lib; declare the minimal shape we use.
declare global {
  interface Window {
    SpeechRecognition?: any;
    webkitSpeechRecognition?: any;
  }
}

interface QuotaStatus {
  tracked: boolean;
  used?: number;
  limit?: number;
  remaining?: number;
}

export default function QueryBar({ onSubmit, loading, onRequestLocation, locationStatus }: QueryBarProps) {
  const [text, setText] = useState('');
  const [isListening, setIsListening] = useState(false);
  const [voiceSupported, setVoiceSupported] = useState(false);
  const [quota, setQuota] = useState<QuotaStatus | null>(null);
  const recognitionRef = useRef<any>(null);

  // Dev-only: refresh the self-tracked Google free-tier quota display after
  // each search, so it's visible how much of today's cap is used up.
  useEffect(() => {
    if (loading) return;
    fetch('/api/quota')
      .then((res) => res.json())
      .then(setQuota)
      .catch(() => {});
  }, [loading]);

  useEffect(() => {
    const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!SpeechRecognition) return;

    setVoiceSupported(true);
    const recognition = new SpeechRecognition();
    recognition.continuous = false;
    recognition.interimResults = false;
    recognition.lang = 'en-GB';

    recognition.onresult = (event: any) => {
      const transcript = event.results[0][0].transcript;
      setText((prev) => (prev ? `${prev} ${transcript}` : transcript));
    };
    recognition.onend = () => setIsListening(false);
    recognition.onerror = () => setIsListening(false);

    recognitionRef.current = recognition;
  }, []);

  function toggleListening() {
    if (!recognitionRef.current) return;
    if (isListening) {
      recognitionRef.current.stop();
      setIsListening(false);
    } else {
      recognitionRef.current.start();
      setIsListening(true);
    }
  }

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    const trimmed = text.trim();
    if (!trimmed || loading) return;
    onSubmit(trimmed);
  }

  return (
    <form className="query-bar" onSubmit={handleSubmit}>
      <textarea
        rows={2}
        placeholder="e.g. Cheapest E10 near me that's open now"
        value={text}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && !e.shiftKey) {
            e.preventDefault();
            handleSubmit(e);
          }
        }}
      />
      <div className="query-bar-actions">
        {voiceSupported && (
          <button
            type="button"
            className={`icon-btn ${isListening ? 'is-active' : ''}`}
            onClick={toggleListening}
            aria-label={isListening ? 'Stop voice input' : 'Start voice input'}
            title={isListening ? 'Listening… click to stop' : 'Ask by voice'}
          >
            🎤
          </button>
        )}
        <div className="location-row">
          {locationStatus === 'granted' ? (
            <span>📍 Using your location</span>
          ) : (
            <button type="button" onClick={onRequestLocation} disabled={locationStatus === 'requesting'}>
              📍 {locationStatus === 'requesting' ? 'Locating…' : 'Use my location'}
            </button>
          )}
        </div>
        <button type="submit" className="submit-btn" disabled={loading || !text.trim()}>
          {loading ? 'Searching…' : 'Search'}
        </button>
      </div>

      {quota?.tracked && (
        <p className="quota-status">
          Dev: {quota.used}/{quota.limit} Gemini requests used today
          {quota.remaining === 0 ? ' — quota exhausted, resets at midnight PT' : ` (${quota.remaining} left)`}
        </p>
      )}
    </form>
  );
}
