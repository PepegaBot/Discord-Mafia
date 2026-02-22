# Discord Mafia (Arabic RTL Embedded Activity)

This project is split into:

- `backend/`: Express + Socket.IO real-time game engine.
- `frontend/`: Next.js (App Router) + Tailwind UI using `@discord/embedded-app-sdk`.

## Local Run

### 1) Backend

```bash
cd backend
cp .env.example .env
npm install
npm run dev
```

### 2) Frontend

```bash
cd frontend
cp .env.example .env.local
npm install
npm run dev
```

Open `http://localhost:3000`.

## Core Files

- Backend game engine: `backend/server.js`
- Discord SDK bootstrap UI: `frontend/app/page.tsx`
- Vercel token exchange route: `frontend/app/api/discord/token/route.ts`
- Vercel profile route: `frontend/app/api/discord/me/route.ts`
- Global RTL and Dark Deco styling: `frontend/app/globals.css`

## Notes

- OAuth token exchange and `/users/@me` profile lookup run through Next.js API routes on Vercel.
- Socket.IO game traffic in Discord embedded mode goes through mapped prefix (`NEXT_PUBLIC_BACKEND_MAPPING_PREFIX`, default `/backend`) to Render.
- `patchUrlMappings` support is included through `NEXT_PUBLIC_URL_MAPPINGS`.
- Outside Discord, frontend socket connects directly to `NEXT_PUBLIC_BACKEND_URL` for local development.

See `DEPLOYMENT.md` for the full Vercel + Render + Discord Portal setup.
