# Deployment Guide (Free Tiers)

## 1. Deploy Backend to Render

1. Push the project to GitHub.
2. In Render, create a **Web Service** from the repo.
3. Set **Root Directory** to `backend`.
4. Set **Environment** to `Node`.
5. Use these commands:
- Build Command: `npm install`
- Start Command: `npm start`
6. Add environment variables:
- `PORT=10000`
- `DISCORD_CLIENT_ID=<your_discord_app_id>`
- `DISCORD_CLIENT_SECRET=<your_discord_client_secret>`
- `ALLOWED_ORIGINS=https://<your-vercel-domain>.vercel.app,http://localhost:3000`
- Optional: `DISCORD_REDIRECT_URI=https://<your-vercel-domain>.vercel.app/`
7. Deploy and keep your final Render URL, for example:
- `https://mafia-backend.onrender.com`

## 2. Deploy Frontend to Vercel

1. In Vercel, import the same repository.
2. Set **Root Directory** to `frontend`.
3. Framework preset: `Next.js`.
4. Add environment variables:
- `NEXT_PUBLIC_DISCORD_CLIENT_ID=<your_discord_app_id>`
- `NEXT_PUBLIC_BACKEND_URL=https://mafia-backend.onrender.com`
- `NEXT_PUBLIC_BACKEND_MAPPING_PREFIX=/backend`
- `NEXT_PUBLIC_URL_MAPPINGS=/backend|mafia-backend.onrender.com`
5. Deploy and note your Vercel URL:
- `https://mafia-activity.vercel.app`

## 3. Configure Discord Developer Portal

Open **Discord Developer Portal -> Applications -> Your App**.

### Embedded App

1. Set the Embedded App URL to your Vercel frontend URL:
- `https://mafia-activity.vercel.app`
2. In **URL Mappings**, add:
- Prefix: `/backend`
- Target: `mafia-backend.onrender.com`
3. Save changes.

This mapping allows frontend requests like `/backend/api/discord/token` and `/backend/socket.io` to proxy securely to Render inside Discord.

### OAuth2 Redirect URIs

1. Go to **OAuth2 -> General**.
2. Add your frontend URL as Redirect URI:
- `https://mafia-activity.vercel.app/`
3. If you set `DISCORD_REDIRECT_URI` on Render, it must match exactly one Redirect URI here.

## 4. CORS and WebSocket Validation

1. Ensure Render `ALLOWED_ORIGINS` includes your Vercel URL.
2. Confirm backend health endpoint:
- `https://mafia-backend.onrender.com/health`
3. Launch the Activity in your private Discord server voice channel.
4. Check that:
- OAuth modal appears.
- Player profile auto-loads.
- Socket connection status shows connected.
- Room ID defaults to the voice `channelId`.

## 5. Private Server Usage Checklist

1. Invite/install the application in your private server with the required scopes.
2. Start a voice channel session.
3. Launch the Embedded App from that channel.
4. Have all players join the same voice channel so they share one room ID.

## 6. Recommended Production Notes

1. Render free instances can sleep; first join may be delayed.
2. Keep frontend and backend env values in sync whenever URLs change.
3. If you add third-party network libraries, append new mappings to `NEXT_PUBLIC_URL_MAPPINGS` in `prefix|target` format.
