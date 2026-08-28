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
- Mic — proximity voice, off by default
- Chat — nearby players only
- Look — hat / top / accessory
- Players — local mute; kick/ban/global mute/promote if admin or owner

## Stack

- Client: Vite, Three.js (orthographic isometric), Colyseus.js, claymorphism overlay
- Server: Colyseus rooms `klase-1` … `klase-3`, 12 regulars per room (owner/admin bypass)
- Auth/DB: optional Supabase (`docs/supabase.sql`)
