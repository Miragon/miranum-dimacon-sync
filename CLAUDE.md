# Miranum App Template — Agent Notes

## Architektur

Single-Repo, pnpm-Workspace. Frontend + Backend in einem Service:

```
src/client/      React SPA (TanStack Router, Vite, Tailwind v4)
src/server/      Hono Backend (Port 3020)
  ├─ lib/        env reader + lazy client singletons
  └─ routes/     /api/{clockin,dimacon,lexoffice}/...
packages/clients/{clockin,dimacon,lexoffice}/   workspace API clients
```

Dev: `pnpm dev` startet Client + Server parallel. Vite proxied `/api` → Hono.
Prod: `pnpm build` (Vite-Client) + `pnpm start` (`tsx src/server/index.ts`,
serviert API + Static). Keine TanStack Start Server-Functions — alle externen
API-Calls laufen über Hono-Routes.

## Design-Disziplin (Miranum "Swiss Lab")

Vollständige Referenz: **`.claude/skills/miranum-design/SKILL.md`** (Tokens,
Komponenten, Do/Don't, Page-Header-Pattern). Visuelle Live-Demo:
`.context/attachments/style-guide.html` (im Browser öffnen).

Kurz-Regeln: Square corners überall, 1px-Borders, kein Shadow/Gradient,
Akzent-Rot maximal einmal pro Screen, Mono nur für Labels/Daten,
Group-Farben nur auf ElementBox/MnFeature.

ElementBox + Bereich-Kicker sind **Landing/Dashboard-Patterns** — nicht als
Page-Header-Schmuck auf jeder Subpage.

## Pages-Konvention

- `/` — Landing/Dashboard (Hero + ElementBox + Feature-Grid)
- `/modules` — Beispiel App-Surface (schlichter Header + Module-Grid + Tabelle)
- `/sync` — Dimacon → Clockin Sync UI (schlichter Header + Form + Result)
- `/settings` — Sync-Scheduler konfigurieren (Cron, Timezone, Enabled)

## Settings-Persistenz

Sync-Scheduler (Cron, Timezone, Enabled) wird via UI editiert und in
`SETTINGS_PATH` (JSON, default `./data/settings.json`) persistiert. PUT auf
`/api/settings/sync` validiert + restartet den Scheduler hot. Env-Vars
`SYNC_CRON` / `SYNC_TZ` dienen nur als Erst-Seed beim allerersten Start.
Auf Fly: Volume an `/data` mounten, `SETTINGS_PATH=/data/settings.json`.

## Quality Gates

`pnpm typecheck && pnpm lint && pnpm format:check && pnpm build` müssen alle grün
sein. Pre-Commit-Hook erzwingt das via Husky + lint-staged.

## Backend / Env

API-Tokens: `process.env`-Variablen, lazy validation beim ersten Request. Variablen
und Pflichtangaben siehe README. Niemals API-Tokens als `VITE_*` exportieren —
Browser-Bundle ist public.

## Auth (WorkOS)

Public-Client-PKCE-Flow via `@workos-inc/authkit-react` im Frontend, JWKS-
basierte JWT-Verifikation via `jose` im Backend. Middleware sitzt in
`src/server/lib/auth.ts` und wird vor `/api/clockin|dimacon|lexoffice|settings`
gemountet (Reihenfolge in `src/server/index.ts` ist load-bearing — `/api/sync`
wird **vor** der Middleware gemountet, damit `healthz` + `run` offen bleiben).
Wenn `WORKOS_CLIENT_ID` leer ist, ist Auth aus (Dev-Fallback). Frontend-Gate
prüft `VITE_WORKOS_CLIENT_ID` build-time und mountet `<AuthKitProvider>` +
`<AuthGate>` nur dann. Alle UI-Fetches gehen über `useApiFetch()` in
`src/client/lib/api.ts`, das den Bearer-Header anhängt.
