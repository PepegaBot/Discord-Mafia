import { NextResponse } from 'next/server';

type JsonRecord = Record<string, unknown>;

function parseRetryAfterSeconds(value: string | null) {
  if (!value) {
    return 0;
  }

  const numeric = Number(value);
  if (!Number.isNaN(numeric) && numeric > 0) {
    return numeric;
  }

  const epochMs = Date.parse(value);
  if (!Number.isNaN(epochMs)) {
    return Math.max(0, (epochMs - Date.now()) / 1000);
  }

  return 0;
}

async function postDiscordToken(payload: URLSearchParams, retries = 2): Promise<Response> {
  const response = await fetch('https://discord.com/api/v10/oauth2/token', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      Accept: 'application/json',
      'User-Agent': 'DiscordMafiaActivity/1.0',
    },
    body: payload,
    cache: 'no-store',
  });

  if (response.status === 429 && retries > 0) {
    const retryAfter = parseRetryAfterSeconds(response.headers.get('retry-after'));
    const waitMs = Math.max(800, Math.ceil(retryAfter * 1000));
    await new Promise((resolve) => setTimeout(resolve, waitMs));
    return postDiscordToken(payload, retries - 1);
  }

  return response;
}

export async function POST(req: Request) {
  try {
    const body = (await req.json()) as JsonRecord;
    const code = typeof body.code === 'string' ? body.code.trim() : '';

    if (!code) {
      return NextResponse.json({ error: 'Missing OAuth code.' }, { status: 400 });
    }

    const clientId = process.env.DISCORD_CLIENT_ID?.trim();
    const clientSecret = process.env.DISCORD_CLIENT_SECRET?.trim();
    const redirectUri = process.env.DISCORD_REDIRECT_URI?.trim();

    if (!clientId || !clientSecret) {
      return NextResponse.json(
        {
          error: 'Missing DISCORD_CLIENT_ID or DISCORD_CLIENT_SECRET in Vercel environment.',
        },
        { status: 500 },
      );
    }

    const payload = new URLSearchParams({
      client_id: clientId,
      client_secret: clientSecret,
      grant_type: 'authorization_code',
      code,
    });

    if (redirectUri) {
      payload.set('redirect_uri', redirectUri);
    }

    const discordResponse = await postDiscordToken(payload);
    const raw = await discordResponse.text();

    let parsed: JsonRecord | null = null;
    try {
      parsed = JSON.parse(raw) as JsonRecord;
    } catch {
      return NextResponse.json(
        {
          error: 'Discord token endpoint returned non-JSON response.',
          status: discordResponse.status,
          contentType: discordResponse.headers.get('content-type'),
          finalUrl: discordResponse.url,
          bodyPreview: raw.slice(0, 500),
        },
        { status: 502 },
      );
    }

    if (!discordResponse.ok) {
      return NextResponse.json(
        {
          error: 'Discord OAuth token exchange failed.',
          details: parsed,
        },
        { status: discordResponse.status },
      );
    }

    return NextResponse.json(parsed, { status: 200 });
  } catch (error) {
    return NextResponse.json(
      {
        error: 'Unexpected token route error.',
        details: error instanceof Error ? error.message : String(error),
      },
      { status: 500 },
    );
  }
}
