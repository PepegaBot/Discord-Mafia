import { NextResponse } from 'next/server';

function getAccessToken(req: Request) {
  const authHeader = req.headers.get('authorization') || '';
  if (authHeader.startsWith('Bearer ')) {
    return authHeader.slice('Bearer '.length).trim();
  }

  const url = new URL(req.url);
  return url.searchParams.get('access_token')?.trim() || '';
}

function defaultAvatarUrl(discriminator: string | undefined) {
  const index = Number(discriminator || 0) % 5;
  return `https://cdn.discordapp.com/embed/avatars/${index}.png`;
}

function avatarUrlFromDiscordUser(user: {
  id: string;
  avatar?: string | null;
  discriminator?: string;
}) {
  if (user.avatar) {
    return `https://cdn.discordapp.com/avatars/${user.id}/${user.avatar}.png?size=128`;
  }

  return defaultAvatarUrl(user.discriminator);
}

export async function GET(req: Request) {
  try {
    const accessToken = getAccessToken(req);

    if (!accessToken) {
      return NextResponse.json({ error: 'Missing access token.' }, { status: 400 });
    }

    const response = await fetch('https://discord.com/api/v10/users/@me', {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        Accept: 'application/json',
        'User-Agent': 'DiscordMafiaActivity/1.0',
      },
      cache: 'no-store',
    });

    const raw = await response.text();

    let parsed: Record<string, unknown> | null = null;
    try {
      parsed = JSON.parse(raw) as Record<string, unknown>;
    } catch {
      return NextResponse.json(
        {
          error: 'Discord profile endpoint returned non-JSON response.',
          status: response.status,
          contentType: response.headers.get('content-type'),
          bodyPreview: raw.slice(0, 500),
        },
        { status: 502 },
      );
    }

    if (!response.ok) {
      return NextResponse.json(
        {
          error: 'Failed to fetch Discord profile.',
          details: parsed,
        },
        { status: response.status },
      );
    }

    const id = String(parsed.id || '');
    const username = String(parsed.username || '');
    const displayName = String(parsed.global_name || username);

    return NextResponse.json(
      {
        id,
        username,
        displayName,
        avatar: avatarUrlFromDiscordUser({
          id,
          avatar: typeof parsed.avatar === 'string' ? parsed.avatar : null,
          discriminator: typeof parsed.discriminator === 'string' ? parsed.discriminator : undefined,
        }),
        raw: parsed,
      },
      { status: 200 },
    );
  } catch (error) {
    return NextResponse.json(
      {
        error: 'Unexpected profile route error.',
        details: error instanceof Error ? error.message : String(error),
      },
      { status: 500 },
    );
  }
}
