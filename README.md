# Discord Mafia (Arabic RTL Embedded Activity)

This project is split into:

- `backend/`: Express + Socket.IO game engine and Discord OAuth code exchange.
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
- Global RTL and Dark Deco styling: `frontend/app/globals.css`

## Notes

- In Discord embedded mode, API calls are expected to go through a mapped prefix (`NEXT_PUBLIC_BACKEND_MAPPING_PREFIX`, default `/backend`).
- `patchUrlMappings` support is included in the frontend through `NEXT_PUBLIC_URL_MAPPINGS`.
- Outside Discord, the frontend connects directly to `NEXT_PUBLIC_BACKEND_URL` for local development.

See `DEPLOYMENT.md` for the full Vercel + Render + Discord Portal setup.
