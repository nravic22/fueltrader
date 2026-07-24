import { NextRequest, NextResponse } from 'next/server';
import { generateText } from 'ai';
import { anthropic } from '@ai-sdk/anthropic';
import { parseQueryIntent } from '@/lib/queryIntent';
import { runStationQuery } from '@/lib/queryBuilder';
import { geocode } from '@/lib/geocode';

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

    const answer = await summarizeResults(query, results);

    return NextResponse.json({ answer, results });
  } catch (err) {
    console.error('Query API error:', err);
    return NextResponse.json({ error: 'Something went wrong answering that — please try again.' }, { status: 500 });
  }
}

async function summarizeResults(userQuery: string, results: Awaited<ReturnType<typeof runStationQuery>>): Promise<string> {
  // The LLM only formats the answer here — it never invents the numbers.
  // The actual prices/distances came straight from the SQL query above.
  const { text } = await generateText({
    model: anthropic('claude-haiku-4-5-20251001'),
    system:
      'You summarize UK fuel station search results in 2-3 friendly, concise sentences. ' +
      'Only use the exact figures given to you — never estimate or round in a way that changes the number. ' +
      'Mention the top result by name and price/distance as appropriate, and note how many total results were found.',
    prompt: `Visitor asked: "${userQuery}"\n\nResults (already sorted):\n${JSON.stringify(results.slice(0, 10), null, 2)}`,
  });

  return text;
}
