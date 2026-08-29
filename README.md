# Klase

Real-time 3D multiplayer classroom in the browser. Walk around an isometric classroom, talk to people near you, customize a primitive avatar.

## Run locally

Needs Node 20+.

```bash
npm install
npm run dev
```

- App: http://localhost:5173
- Game server: `ws://localhost:2567`

Open two browser tabs for multiplayer. Guest join works with no cloud accounts.

Copy `.env.example` to `.env` (repo root or `server/`) when you want Supabase accounts. Run `docs/supabase.sql` in the SQL editor. Set `KLASE_OWNER_USER_ID` or `KLASE_OWNER_EMAIL` so owner is not a spoofable display name. Until those keys exist, display name `Hakkai` is owner in guest-dev only.

## Controls

- WASD / arrows — move (screen-relative on the isometric floor)
- Phone / tablet — on-screen joystick (bottom left). Sit / Stand appears next to it when you can use a chair
- Mic — proximity voice, off by default
- Chat — nearby players only
- Look — hat / top / accessory
- Players — local mute; kick/ban/global mute/promote if admin or owner
- E — sit / stand on desktop; Space also stands

## Deploy (beginner): Render + Vercel

You do **not** need Supabase for guest join. Skip those keys until you want email accounts.

**Vercel** hosts the website. **Render** hosts the game server (who is in the room). Both are required for [klase-tan.vercel.app](https://klase-tan.vercel.app) to join.

### 1. Push this repo to GitHub `main`

Render and Vercel both deploy from GitHub.

### 2. Create a Render web service

1. Sign up at [render.com](https://render.com) with GitHub and allow the **Klase** repo.
2. **New** → **Web Service** → connect **Klase**.
3. Set:

| Field | Value |
|---|---|
| Name | `klase-server` |
| Language | Node |
| Branch | `main` |
| Root Directory | leave **empty** (whole repo) |
| Build Command | `npm install` |
| Start Command | `npm run start -w server` |
| Instance | Free |

4. Environment: add `NODE_VERSION` = `20`. Do **not** set `SUPABASE_*`. Render sets `PORT` for you.
5. Deploy. In **Settings**, Health Check Path = `/health`.
6. When logs show `Klase server on :…`, copy the URL, e.g. `https://klase-server.onrender.com`. Open `https://YOUR-SERVICE.onrender.com/health` — you should see `{"ok":true}`.

Free Render **sleeps** after ~15 minutes. The first join after sleep can take 30–60 seconds.

### 3. Point Vercel at Render

Vite bakes env vars at **build** time. You must redeploy after adding them.

1. Vercel project → **Settings** → **Environment Variables** → Production:

| Name | Value |
|---|---|
| `VITE_COLYSEUS_URL` | `wss://YOUR-SERVICE.onrender.com` (must be **wss**, not `ws`) |
| `VITE_API_URL` | `https://YOUR-SERVICE.onrender.com` |

No trailing slash. Use your real Render hostname.

2. **Deployments** → **Redeploy** (or push a new commit). Wait until it succeeds.
3. Hard-refresh the Vercel site and **Join as guest**.

Vercel: Root Directory empty (repo root), Output Directory `dist`.

Local play is unchanged: `npm run dev` (no Render needed).

## Stack

- Client: Vite, Three.js (orthographic isometric), Colyseus.js, claymorphism overlay
- Server: Colyseus rooms `klase-1` … `klase-3`, 12 regulars per room (owner/admin bypass)
- Auth/DB: optional Supabase (`docs/supabase.sql`)
