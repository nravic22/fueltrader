import { NextRequest, NextResponse } from 'next/server';
import { generateText } from 'ai';
import { getLLMModel } from '@/lib/llm';
import { parseQueryIntent } from '@/lib/queryIntent';
import { runStationQuery, runRouteStationQuery, type StationResult } from '@/lib/queryBuilder';
import { geocode } from '@/lib/geocode';
import { getDrivingRoute, metersToMiles } from '@/lib/route';

export const runtime = 'nodejs';

interface RequestBody {
  query: string;
  userLocation?: { lat: number; lng: number } | null;
}

export async function POST(req: NextRequest) {
  try {
    const body = (await req.json()) as RequestBody;
    const query = (body.query ?? '').trim();

    if (!query) {
      return NextResponse.json({ error: 'Please enter a question.' }, { status: 400 });
    }
    if (query.length > 500) {
      return NextResponse.json({ error: 'Please keep your question under 500 characters.' }, { status: 400 });
    }

    const hasGps = Boolean(body.userLocation);
    const intent = await parseQueryIntent(query, hasGps);

    // A trip/route query names both a start and end place — handle it
    // separately since it needs a driving route, not a single search point.
    if (intent.location_text && intent.destination_text) {
      const [origin, destination] = await Promise.all([
        geocode(intent.location_text),
        geocode(intent.destination_text),
      ]);

      if (!origin) {
        return NextResponse.json(
          { error: `I couldn't find a place matching "${intent.location_text}". Try a full postcode or town name.` },
          { status: 400 }
        );
      }
      if (!destination) {
        return NextResponse.json(
          { error: `I couldn't find a place matching "${intent.destination_text}". Try a full postcode or town name.` },
          { status: 400 }
        );
      }

      const route = await getDrivingRoute(origin, destination);
      if (!route) {
        return NextResponse.json(
          { error: `I couldn't find a driving route between "${intent.location_text}" and "${intent.destination_text}".` },
          { status: 400 }
        );
      }

      const results = await runRouteStationQuery(intent, route);

      if (results.length === 0) {
        return NextResponse.json({
          answer: "I couldn't find any stations along that route — try widening the search radius.",
          results: [],
          route: { coordinates: route.coordinates },
        });
      }

      const answer = await summarizeResults(query, results, intent.brand_name, {
        origin: intent.location_text,
        destination: intent.destination_text,
        totalMiles: metersToMiles(route.distanceMeters),
      });

      return NextResponse.json({
        answer,
        results,
        route: { coordinates: route.coordinates },
      });
    }

    // Resolve the location to actual coordinates, if the question needs one.
    let location: { lat: number; lng: number } | null = null;
    if (intent.location_text) {
      location = await geocode(intent.location_text);
      if (!location) {
        return NextResponse.json(
          { error: `I couldn't find a place matching "${intent.location_text}". Try a full postcode or town name.` },
          { status: 400 }
        );
      }
    } else if (intent.needs_location && body.userLocation) {
      location = body.userLocation;
    } else if (intent.needs_location && !body.userLocation) {
      return NextResponse.json(
        {
          error: 'This question needs a location. Share your location, or mention a town/postcode in your question.',
          needsLocation: true,
        },
        { status: 400 }
      );
    }

    const results = await runStationQuery(intent, location);

    if (results.length === 0) {
      return NextResponse.json({
        answer: "I couldn't find any stations matching that — try widening the search radius or removing a filter.",
        results: [],
      });
    }

    const answer = await summarizeResults(query, results, intent.brand_name);

    return NextResponse.json({ answer, results });
  } catch (err) {
    console.error('Query API error:', err);
    return NextResponse.json({ error: 'Something went wrong answering that — please try again.' }, { status: 500 });
  }
}

async function summarizeResults(
  userQuery: string,
  results: StationResult[],
  brandNameQueried?: string | null,
  routeContext?: { origin: string; destination: string; totalMiles: number }
): Promise<string> {
  const semanticMatchCount = results.filter((r) => r.matched_via_semantic).length;
  const semanticNote =
    semanticMatchCount > 0
      ? `\n\nNote: ${semanticMatchCount} of these results matched "${brandNameQueried}" by similar/approximate name (e.g. a slightly different spelling or store format), not an exact name match — briefly mention this so the visitor understands why those names look a bit different.`
      : '';

  // The LLM only formats the answer here — it never invents the numbers.
  // The actual prices/distances came straight from the SQL query above.
  const { text } = await generateText({
    model: getLLMModel(),
    system: routeContext
      ? 'You summarize fuel stations found along a planned UK driving route, in 2-3 friendly, concise sentences. ' +
        'Only use the exact figures given to you — never estimate or round in a way that changes the number. ' +
        'Mention the route, roughly how many stops were found, and call out one or two good options (e.g. cheapest, or well spread along the way).'
      : 'You summarize UK fuel station search results in 2-3 friendly, concise sentences. ' +
        'Only use the exact figures given to you — never estimate or round in a way that changes the number. ' +
        'Mention the top result by name and price/distance as appropriate, and note how many total results were found.',
    prompt: routeContext
      ? `Visitor is planning a ${routeContext.totalMiles.toFixed(0)}-mile drive from ${routeContext.origin} to ${routeContext.destination} and asked: "${userQuery}"\n\nStations found along the route, ordered start to end (route_position_miles is how far into the trip each one is):\n${JSON.stringify(results.slice(0, 15), null, 2)}${semanticNote}`
      : `Visitor asked: "${userQuery}"\n\nResults (already sorted):\n${JSON.stringify(results.slice(0, 10), null, 2)}${semanticNote}`,
  });

  return text;
}
