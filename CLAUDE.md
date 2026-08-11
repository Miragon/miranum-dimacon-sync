# Miranum App Template — Agent Notes

## Architektur

Single-Repo (ein pnpm-Package). Frontend + Backend in einem Service:

```
src/client/      React SPA (TanStack Router, Vite, Tailwind v4)
src/server/      Hono Backend (Port 3020)
  ├─ lib/        env reader + lazy client singletons + settings
  ├─ integrations/   Integrations-Registry (Mutex, Scheduler, Definitionen)
  │   ├─ shared/            gemeinsame Loader/Helper (Dimacon, Zeit)
  │   ├─ dimacon-clockin/   Tagesplanung Dimacon → Clockin (OHNE Lexware)
  │   └─ dimacon-lexoffice/ Kunden-Sync Dimacon → Lexware Office
  └─ routes/     /api/{clockin,dimacon,lexoffice,integrations,settings}/...
```

API-Clients kommen als externe npm-Deps (`@miragon/client-{clockin,dimacon,lexoffice}`)
aus dem Repo Miragon/miranum-clients — hier nur konsumiert, nicht generiert.

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
- `/modules` — Die 3 angebundenen Systeme mit echtem Konfigurations-Status
  aus `GET /api/systems` (ElementBox-Grid + Status-Tabelle, Links zu den
  Integrationen)
- `/sync` — Integrations-Übersicht (Tabelle aller Integrationen mit Status)
- `/sync/$integrationId` — Detail: Run-Form (Datum, dryRun) + Result-View;
  unbekannte Integrationen bekommen einen JSON-Fallback-Renderer
- `/settings` — Scheduler je Integration konfigurieren (Cron, Timezone, Enabled)

## Integrationen

Eine Integration = Modul unter `src/server/integrations/<id>/` mit
`defineIntegration({ id, name, systems, requiredEnv, inputSchema, run })`,
registriert in `integrations/registry.ts`. Damit automatisch: eigener Mutex
(`runIntegration` → 409 bei parallelem Lauf), eigener Cron-Slot, Routen
`/api/integrations/:id/{run,healthz}` + Eintrag in `/sync` und `/settings`.
`requiredEnv` steuert den „konfiguriert"-Status (kein Crash bei fehlender Env
— Run liefert 503). Der Dimacon→Clockin-Sync ist bewusst NICHT von Lexware
abhängig; das Kundennummern-Alignment liegt in `dimacon-lexoffice`.
`/api/sync/{run,healthz}` ist Legacy-Alias für `dimacon-clockin`.

**UI pro Integration** (`src/client/components/integrations/`) — alles
optional, ohne Registrierung greifen Defaults:

- Ergebnis-Ansicht: `<Name>Result.tsx` + Dispatch-Zeile in
  `RunResultView.tsx` (Default: JSON-`<pre>`-Fallback).
- Run-Form nur wenn der Input nicht `{ date?, dryRun? }` ist: Komponente +
  Eintrag in der `FORMS`-Map in `RunForm.tsx` (Default: Datum+dryRun-Form).
- Größere eigene Screens: eigene Route-Dateien, z. B.
  `src/client/routes/sync.<id>.review.tsx` → `/sync/<id>/review` —
  statische Segmente gewinnen im TanStack-Matching gegen `$integrationId`.

## Settings-Persistenz

Scheduler-Settings (Cron, Timezone, Enabled) liegen **pro Integration** in
`SETTINGS_PATH` (JSON, keyed nach Integration-ID, default
`./data/settings.json`). PUT auf `/api/settings/integrations/:id` validiert +
restartet den jeweiligen Cron hot. Alte Dateien in `{ "sync": ... }`-Form
werden beim Laden automatisch auf `dimacon-clockin` migriert. Env-Vars
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
und der Integrations-Liste gemountet (Reihenfolge in `src/server/index.ts` ist
load-bearing — `/api/sync` und die offenen Integrations-Routen
`/api/integrations/:id/{run,healthz}` werden **vor** der Middleware gemountet,
damit Webhook + Status offen bleiben; `run` schützt sich per
`SYNC_WEBHOOK_SECRET`).
Wenn `WORKOS_CLIENT_ID` leer ist, ist Auth aus (Dev-Fallback). Frontend-Gate
prüft `VITE_WORKOS_CLIENT_ID` build-time und mountet `<AuthKitProvider>` +
`<AuthGate>` nur dann. Alle UI-Fetches gehen über `useApiFetch()` in
`src/client/lib/api.ts`, das den Bearer-Header anhängt.
