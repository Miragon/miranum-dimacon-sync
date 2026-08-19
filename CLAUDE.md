# Miranum App Template — Agent Notes

## Architektur

Single-Repo (ein pnpm-Package). Frontend + Backend in einem Service,
**multi-mandantenfähig**: eine WorkOS-Organisation = ein Mandant.

```
src/client/      React SPA (TanStack Router, Vite, Tailwind v4)
src/server/      Hono Backend (Port 3020)
  ├─ db/         Drizzle: schema.ts + migrations/ (fahren im Docker-Image mit,
  │              laufen programmatisch beim Boot) + repos/ (tenants,
  │              credentials, schedules, field-mappings, webhook-secrets,
  │              sync-runs) + seed-legacy.ts (einmaliger Env→DB-Import)
  ├─ lib/        env reader + Tenant-Middleware (tenant.ts) + Crypto
  │              (crypto.ts, AES-256-GCM-Key-Ring) + Client-Factory
  │              (clients.ts, je Mandant) + http helper
  ├─ integrations/   Integrations-Registry (Mutex + Cron je (Mandant,
  │   │              Integration), recordRun → sync_runs)
  │   ├─ shared/            gemeinsame Loader/Helper (Dimacon, Zeit) +
  │   │                     Feld-Zuordnungs-Framework (field-catalog,
  │   │                     field-mapping, mapping-context)
  │   ├─ dimacon-clockin/   kompletter Clockin-Sync (OHNE Lexware):
  │   │   └─ employee-sync/ Schritt 1 — bidirektionaler Mitarbeiter-
  │   │                     Stammdaten-Abgleich; danach Tagesplanung
  │   └─ dimacon-lexoffice/ Kunden-Sync + Nummern-Alignment Dimacon → Lexware
  └─ routes/     /api/{clockin,dimacon,lexoffice,integrations,settings,
                 mappings,credentials,systems,me,tenants}/...
```

API-Clients kommen als externe npm-Deps (`@miragon/client-{clockin,dimacon,lexoffice}`)
aus dem Repo Miragon/miranum-clients — hier nur konsumiert, nicht generiert.

Dev: `pnpm stack:up` (Postgres 17 aus `stack/docker-compose.yml`, Host-Port
5400), dann `pnpm dev` (Client + Server
parallel, Vite proxied `/api` → Hono). Prod: `pnpm build` + `pnpm start`
(`tsx src/server/index.ts`). Migrationen laufen beim Boot unter einem
pg_advisory_lock; `pnpm db:generate` erzeugt neue Migrationen aus
Schema-Änderungen (CI prüft Drift via generate+diff; `drizzle-kit check`
validiert nur die Snapshot-Historie).

## Mandanten-Modell (load-bearing)

- `org_id`-Claim des WorkOS-JWT → `tenants`-Zeile (`resolveTenant` in
  `src/server/lib/tenant.ts`, 30-s-Cache). Die Tabelle IST die
  Zugangs-Allowlist: **fail-closed, kein HTTP-Endpoint zur Tenant-Anlage** —
  nur `scripts/create-tenant.ts` (bewusste Sicherheitsentscheidung).
- Fehler-Codes der 403s: `NO_ORG` / `UNKNOWN_ORG` / `ORG_INACTIVE` — das
  Client-`TenantGate` matcht exakt darauf.
- Auth aus (Dev): echte DB-Zeile `org_dev` via `getOrCreateDevTenant()`.
- API-Pfade bleiben tenant-frei — der Mandant kommt IMMER aus dem JWT bzw.
  Webhook-Secret, nie vom Client.
- Credentials-Schreibrechte: jedes Mitglied einer freigeschalteten Org
  (dokumentierte Entscheidung, internes Ops-Tool).

## Credentials & Crypto

API-Tokens liegen AES-256-GCM-verschlüsselt in `tenant_credentials`
(Envelope-String `v1:<keyId>:<iv>:<tag>:<ct>`, AAD = Tenant-UUID + System —
Ciphertext-Verschieben zwischen Zeilen scheitert an GCM). Key-Ring aus
`CREDENTIAL_KEYS` (linkester Eintrag verschlüsselt; Rotation via
`src/server/db/rotate-credentials.ts`). Nicht-Geheimes (baseUrl,
Dimacon-tenant) liegt als Klartext-`config`-jsonb daneben — Status-Reads
brauchen keinen Decrypt. **Decrypt-Fehler nie als „nicht konfiguriert"
maskieren** — `CredentialCryptoError` ist ein eigener 500-Pfad (Meldung
nennt die Abhilfe: Token neu speichern). Dev-Server NIE mit
Inline-Zufallskey starten — `CREDENTIAL_KEYS` kommt stabil aus `.env`,
sonst werden in der persistenten Dev-DB gespeicherte Tokens unbrauchbar.
UI: Dimacon unter `/settings` (gemeinsames Quellsystem), Clockin/Lexware auf
der Einstellungsseite ihrer Integration `/sync/<id>/settings` (Token-Feld
immer leer; leer lassen = behalten).
Niemals API-Tokens als `VITE_*` exportieren — Browser-Bundle ist public.

## Pages-Konvention

- `/` — Landing/Dashboard (Hero + ElementBox + Feature-Grid)
- `/modules` — Die 3 angebundenen Systeme mit Konfigurations-Status des
  aktiven Mandanten aus `GET /api/systems`
- `/sync` — Integrations-Übersicht (Tabelle aller Integrationen mit Status)
- `/sync/$integrationId` — Detail: Run-Form (Datum, dryRun) + Result-View;
  unbekannte Integrationen bekommen einen JSON-Fallback-Renderer
- `/settings` — zentral: Dimacon-Zugangsdaten + Linkliste zu den
  Integrations-Einstellungen
- `/sync/$integrationId/settings` — je Integration, erreichbar über das
  Zahnrad in der /sync-Tabelle (einziger Nav-Einstieg): Tab-Menü
  Zeitplan | Zugangsdaten (Zielsystem) | Feld-Zuordnung (eingebetteter
  Editor); aktiver Tab als Search-Param `?tab=…`. Der Zeitplan-Editor ist
  Picker-basiert (Täglich mit Uhrzeit + Mo–So-Chips | Intervall aus
  kuratierten Teilern von 60/24 | Experte = rohes Cron-Feld) und übersetzt
  client-seitig nach Cron (`src/client/lib/schedule-cron.ts`); nicht
  abbildbare Bestands-Crons öffnen automatisch im Experten-Modus

## Design-Disziplin (Miranum "Swiss Lab")

Vollständige Referenz: **`.claude/skills/miranum-design/SKILL.md`** (Tokens,
Komponenten, Do/Don't, Page-Header-Pattern). Visuelle Live-Demo:
`.context/attachments/style-guide.html` (im Browser öffnen).

Kurz-Regeln: Square corners überall, 1px-Borders, kein Shadow/Gradient,
Akzent-Rot maximal einmal pro Screen, Mono nur für Labels/Daten,
Group-Farben nur auf ElementBox/MnFeature.

ElementBox + Bereich-Kicker sind **Landing/Dashboard-Patterns** — nicht als
Page-Header-Schmuck auf jeder Subpage.

## Integrationen

Eine Integration = Modul unter `src/server/integrations/<id>/` mit
`defineIntegration({ id, name, systems, requiredCredentials, inputSchema, run })`,
registriert in `integrations/registry.ts`. `run(ctx, input)` bekommt den
`IntegrationRunContext` (tenantId, trigger, `ctx.clients` = Tenant-Client-
Factory, `ctx.getFieldMapping`, `ctx.log`) — Integrations-Code kennt weder DB
noch Env-Vars; Tests bauen ctx von Hand. Damit automatisch: Mutex je
(Mandant, Integration) (`runIntegration` → 409), Cron-Slots je Mandant,
Run-Historie (`sync_runs`, letzte 50 je Mandant+Integration, keine UI bisher),
Routen `/api/integrations/:id/{run,healthz}` + Eintrag in `/sync`/`/settings`.
`requiredCredentials` (System-IDs) steuert den „konfiguriert"-Status je
Mandant (kein Crash — Run liefert 503 mit `missing`). Der
Dimacon→Clockin-Sync ist bewusst NICHT von Lexware abhängig.
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

## Persistenz (Postgres, tenant-gescoped)

Scheduler-Settings: `schedule_settings` (PK tenant+integration). PUT auf
`/api/settings/integrations/:id` validiert + restartet den Cron des Mandanten
hot. Feld-Zuordnungen: `field_mappings` (PK tenant+integration+entity),
editierbar im Feld-Zuordnungs-Tab der Integrations-Einstellungen
(`/sync/<id>/settings?tab=mapping`) via `/api/mappings/:id[/:entity]`.
Katalog/Engine in `src/server/integrations/shared/field-{catalog,mapping}.ts`;
ohne persistierte Zuordnung gelten die Default-Regeln und es gibt keine
Discovery-API-Calls. Match-Keys (project.number, customer.identifier,
employee-Namen/PN) sind fixiert und nie remappbar. Der dimacon-clockin-Sync
akzeptiert `steps: { employees, customers, projects, assignments, archive }`
im Run-Input (Default: alles an); die Archiv-Phase schützt nur Projekte, die
der Lauf auflöst, deshalb läuft die Projekt-Auflösung auch bei deaktivierten
Schritten.

Die alte settings.json wird nur noch vom **einmaligen Legacy-Seed** gelesen
(`src/server/lib/legacy-settings.ts` parst beide Alt-Formen; Seed-Guard =
`app_meta['legacy-seed']`-Marker + leere tenants-Tabelle). Nach verifiziertem
Seed die Alt-Env-Vars entfernen (Korrektheits-Gate, siehe README).

## Quality Gates

`pnpm typecheck && pnpm lint && pnpm format:check && pnpm build` müssen alle grün
sein. Pre-Commit-Hook erzwingt das via Husky + lint-staged. Tests (`pnpm test`)
fahren DB-Suiten gegen In-Memory-PGlite (`src/server/db/test-db.ts`,
`setDbForTests`) — kein Docker nötig; PGlite ist strikt devDependency
(nur dynamische Imports, sonst crasht das geprunte Prod-Image).

## Auth (WorkOS)

Public-Client-PKCE-Flow via `@workos-inc/authkit-react` im Frontend, JWKS-
basierte JWT-Verifikation via `jose` im Backend (`requireAuth` = reine
Token-Prüfung; Org→Tenant-Auflösung macht `resolveTenant`). Mount-Reihenfolge
in `src/server/app.ts` ist load-bearing: `/api/sync` + offene
Integrations-Routen VOR `requireAuth`; `/api/me` NACH `requireAuth` aber VOR
`resolveTenant` (das Client-TenantGate braucht die strukturierte 403-Antwort
auch für unbekannte Orgs). Die `run`-Webhooks sind **Dual-Auth**:
per-Mandant-Webhook-Secret (`tenant_webhook_secrets`, sha256-Lookup) ODER
gültiges AuthKit-JWT; ohne Treffer 401 (fail-closed, kein globales
`SYNC_WEBHOOK_SECRET` mehr). `app.onError` ist sanitisiert (`internal error`) —
Fehlerdetails nur ins Log, typisierte 4xx/503-Pfade bleiben deutsch.
**In Produktion verweigert `index.ts` den Start ohne `WORKOS_CLIENT_ID` +
`DATABASE_URL` + `CREDENTIAL_KEYS`**; die App-Konstruktion liegt testbar in
`src/server/app.ts` (`createApp()`). Frontend-Gate prüft
`VITE_WORKOS_CLIENT_ID` build-time (deploy.yml übergibt es als
Docker-Build-Arg!) und
mountet `<AuthKitProvider>` + `<AuthGate>` + `<TenantGate>` nur dann. Alle
UI-Fetches gehen über `useApiFetch()` in `src/client/lib/api.ts` (Bearer-Header,
401 → PKCE-Neustart). Mandanten-Switcher im `UserMenu` nutzt
`switchToOrganization` + Hard-Reload.
