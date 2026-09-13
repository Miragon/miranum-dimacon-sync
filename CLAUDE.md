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
  nur `scripts/create-tenant.ts` (bewusste Sicherheitsentscheidung) oder der
  optionale **Org-Sync** (`src/server/tenant-sync.ts`, `WORKOS_ORG_SYNC=on`):
  PULL-only-Reconcile alle 2 min provisioniert Orgs mit Feature-Flag
  `dimacon-sync`. Sync fasst NUR `managed_by='workos-sync'`-Zeilen an,
  reaktiviert nur eigene Deaktivierungen (`deactivated_by`) — Ops-Not-Aus
  (`active=false` per SQL) bleibt stehen; alle Sync-Mutationen sind CAS
  (Guards in der WHERE-Klausel). Guards: Sanity-Check gegen fremde/
  unvollständige Org-Listen, Circuit-Breaker (>2 bzw. >50 % fällige
  Deaktivierungen ⇒ kompletter Lauf abgebrochen), 2 zeitlich getrennte
  Bestätigungs-Läufe, Status in `app_meta['workos-org-sync']`.
- Fehler-Codes der 403s: `NO_ORG` / `UNKNOWN_ORG` / `ORG_INACTIVE` — das
  Client-`TenantGate` matcht exakt darauf.
- Auth aus (Dev): echte DB-Zeile `org_dev` via `getOrCreateDevTenant()`.
- API-Pfade bleiben tenant-frei — der Mandant kommt IMMER aus dem JWT bzw.
  Webhook-Secret, nie vom Client.
- `/api/tenants` (Switcher-Liste) ist membership-gefiltert: WorkOS
  User-Management-API via optionalem `WORKOS_API_KEY` (60-s-Cache in
  `src/server/lib/workos.ts`). Fallback ohne Key/im Dev-Modus/bei
  API-Fehlern: NUR der aktive Mandant — nie alle Mandanten, nie 5xx.
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
immer leer; leer lassen = behalten). „Verbindung testen" POSTet die
Formularwerte an `/api/credentials/:system/test` (Test VOR dem Speichern;
leeres Token = gespeichertes Secret; Wegwerf-Client in
`src/server/lib/connection-test.ts`) — Antwort ist 200 mit `ok:false` +
Meldung bei Upstream-Fehlern, damit nichts im sanitisierten onError landet.
Niemals API-Tokens als `VITE_*` exportieren — Browser-Bundle ist public.

## Pages-Konvention

- `/` — Dashboard: Zustand aller Integrationen (letzter Lauf, nächster Lauf,
  Umfang) + Block „Braucht Aufmerksamkeit" für fehlende Zugangsdaten und
  Fehler-/Skip-Läufe. Bewusst OHNE ElementBox-Hero — die Kacheln verlinkten
  nur, ohne etwas über den Zustand zu sagen
- `/modules` — Die 3 angebundenen Systeme mit Konfigurations-Status des
  aktiven Mandanten aus `GET /api/systems`
- `/sync` — Integrations-Übersicht (Tabelle aller Integrationen mit Status)
- `/sync/$integrationId` — Detail: Run-Form (Datum, dryRun, Schritte —
  vorbelegt aus dem gespeicherten Umfang) + Result-View + Run-Historie;
  unbekannte Integrationen bekommen einen JSON-Fallback-Renderer
- `/settings` — zentral: Dimacon-Zugangsdaten + Linkliste zu den
  Integrations-Einstellungen
- `/sync/$integrationId/settings` — je Integration, erreichbar über das
  Zahnrad in der /sync-Tabelle, den Header-Link auf `/sync/$integrationId` und
  die Wegweiser-Liste auf `/settings`: Tab-Menü
  Zeitplan | Umfang | Zugangsdaten (Zielsystem) | Feld-Zuordnung
  (eingebetteter Editor); aktiver Tab als Search-Param `?tab=…`. Der
  Umfang-Tab erscheint nur für Integrationen mit Eintrag in
  `RUN_SCOPE_SPECS` (`src/client/lib/run-scope.ts` — Single Source of Truth
  für Step-Labels, Warnhinweise und Step-Defaults im Client).
  Der Zeitplan-Editor ist
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

ElementBox + Bereich-Kicker sind **Landing-Patterns** — nicht als
Page-Header-Schmuck auf jeder Subpage, und auch nicht auf dem Dashboard: dort
zählt der Zustand, nicht die Dekoration.

**Akzent-Rot ist der teuerste Token des Systems.** Es markiert auf
`/sync/$integrationId` den Live-Lauf-Button — das einzige Signal für „dieser
Klick schreibt in drei Produktivsysteme". Checkboxen, Badges und Karten daneben
laufen auf Ink; jedes zusätzliche Rot entwertet genau dieses Signal. Gleiches
auf `/`: der Akzent gehört dem Block „Braucht Aufmerksamkeit".

**Kontrast:** `text-ink-3` (#9a9a96) liegt auf Weiß bei 2,82:1 und ist damit
NUR für Mono-Labels und Metadaten zulässig, nie für Fließtext, den jemand
lesen muss — Bedingungen und Warnhinweise gehören auf `text-ink-2` (5,33:1).

## Integrationen

Eine Integration = Modul unter `src/server/integrations/<id>/` mit
`defineIntegration({ id, name, systems, requiredCredentials, inputSchema, run })`,
registriert in `integrations/registry.ts`. `run(ctx, input)` bekommt den
`IntegrationRunContext` (tenantId, trigger, `ctx.clients` = Tenant-Client-
Factory, `ctx.getFieldMapping`, `ctx.log`) — Integrations-Code kennt weder DB
noch Env-Vars; Tests bauen ctx von Hand. Damit automatisch: Mutex je
(Mandant, Integration) (`runIntegration` → 409), Cron-Slots je Mandant,
Run-Historie (`sync_runs`, letzte 50 je Mandant+Integration; `GET
/api/integrations/:id/runs` liegt auf dem AUTHENTIFIZIERTEN Router und speist
die Tabelle unter `/sync/<id>` mit Auslöser/Modus/Umfang),
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
hot. **Run-Umfang**: `schedule_settings.run_defaults` (jsonb) hält je
(Mandant, Integration) den persistenten Umfang; PUT auf
`/api/settings/integrations/:id/run-defaults` validiert generisch gegen
`def.inputSchema` und speichert normalisiert — **kein Cron-Restart**, der
Scheduler liest zur Feuerzeit. Regeln (alle in
`src/server/integrations/run-input.ts`): `date` wird NIE persistiert (Cron =
immer heute); der Request-Body wird ÜBER die Defaults gemerged (top-level
gewinnt, `steps` eine Ebene tief) — Abweichungen gelten nur für den einen
Lauf; ungültige gespeicherte Defaults sind **fail-closed** (Cron überspringt
mit `log.error` + Historie-Zeile mit Status `skipped` = nie gestartet, daher
ohne Modus/Umfang in der UI; ausgelöste Läufe bekommen 400) statt auf die
Schema-Defaults (= alles an, live) zurückzufallen. Ein gespeicherter Wert, der
gar kein Objekt ist, gilt ebenfalls als ungültig. `updateScheduleSettings` fasst
`run_defaults` bewusst nicht an und umgekehrt. Feld-Zuordnungen: `field_mappings` (PK tenant+integration+entity),
editierbar im Feld-Zuordnungs-Tab der Integrations-Einstellungen
(`/sync/<id>/settings?tab=mapping`) via `/api/mappings/:id[/:entity]`.
Katalog/Engine in `src/server/integrations/shared/field-{catalog,mapping}.ts`;
ohne persistierte Zuordnung gelten die Default-Regeln und es gibt keine
Discovery-API-Calls. Match-Keys (project.number, customer.identifier,
employee-Namen/PN) sind fixiert und nie remappbar. Der dimacon-clockin-Sync
akzeptiert `steps: { employees, customers, projects, assignments, archive,
employeeCreateInDimacon }` im Run-Input (Default: alles an —
**`employeeCreateInDimacon` ist die Ausnahme und per Default AUS**, Issue #17);
die Archiv-Phase schützt (a) Projekte, die der Lauf auflöst — deshalb läuft die
Projekt-Auflösung auch bei deaktivierten Schritten —, (b) alles mit Termin im
Fenster ±`ARCHIVE_HORIZON_DAYS` um **heute UND** um das Sync-Datum
(`run.ts`/`archive.ts`) und (c) Projekte ohne Dimacon-Nummer (die stammen nicht
aus dem Sync). Ist der Horizont unbekannt oder die Clockin-Projektliste
unvollständig geladen, archiviert der Lauf gar nichts und meldet den Grund.

Zwei load-bearing Regeln des Mitarbeiter-Abgleichs: Dimacon-PUTs sind
Voll-Replace — jeder Update-Body spiegelt ALLE geladenen Felder zurück
(`dimaconEmployeeUpdateBody` in `employee-sync/syncer.ts`, sonst verlieren
Mitarbeiter beim Personalnummer-Backfill ihr Team). Und die Anlage ist
fail-closed: wurde der Clockin-Bestand unvollständig geladen
(`shared/clockin-pages.ts` paginiert und meldet Abbruchgründe), legt der Lauf
in KEINER Richtung Mitarbeiter an; nicht angelegte Kandidaten erscheinen mit
deutscher Begründung als `skipped`-Zeile im Ergebnis
(`employee-sync/creation-policy.ts`).

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
401 → EIN Force-Refresh + Retry, danach das Abgelaufen-Overlay — kein
automatischer Redirect, s. u.). Mandanten-Switcher im `UserMenu` nutzt
`switchToOrganization` + Hard-Reload; seine Liste kommt aus dem
membership-gefilterten `/api/tenants` (s. Mandanten-Modell).
**Session-Robustheit (load-bearing):** `useApiFetch()` liefert den von
`createApiFetch()` gebauten Fetch — bei 401 EIN deduplizierter
Force-Refresh (Single-Flight, sonst überschreiben sich die PKCE-Verifier)
plus genau ein Retry. Ein 401 löst KEINEN Redirect mehr aus, sondern den
`sessionExpired`-Zustand des AuthGate (Overlay, Redirect erst auf Klick,
Formular-State überlebt). Die **Identität von `apiFetch` muss stabil
bleiben** — Consumer hängen sie in `useEffect`-Deps, also darf
`sessionExpired` nie in die `useMemo`-Deps von `auth`/`apiFetch`.
**Die Organisation des frischen Tokens ist KEIN Gate.** `warnOnOrganizationDrift`
protokolliert eine Abweichung nur — `useAuth().organizationId` (Response) und
der `org_id`-Claim (JWT) stammen aus verschiedenen Quellen und können
auseinanderlaufen, ohne dass die Sitzung defekt ist. Eine frühere Fassung hat
daraus einen terminalen Fehler gemacht und die UI hinter dem Overlay
eingesperrt, obwohl jeder API-Call weiterlief — ohne Rückweg, weil „Erneut
versuchen" in denselben Vergleich lief. Über die Org entscheidet `resolveTenant`
serverseitig (403 `UNKNOWN_ORG` → TenantGate). `pinOrganization` bleibt: es
schreibt die Org VOR dem erzwungenen Refresh zurück und verhindert den
Mandantenwechsel proaktiv, ohne etwas zu blockieren.

Ebenfalls load-bearing: `isSessionTerminal()` trennt „Session weg" von
„gerade kein Netz" — nur `AuthKitError`-Ableitungen (`LoginRequiredError`)
gelten als endgültig, ein roher `TypeError` aus dem fetch bzw. der
`LockError` des Tab-Locks wird als transienter deutscher Fehler geworfen
(Pendant zu `TOKEN_INVALID_CODES` serverseitig; `err.name` taugt NICHT als
Kriterium, authkit setzt es nicht). Und `pendingRefresh = null` im `finally`
gibt den Single-Flight-Slot wieder frei — ohne das liefert jeder spätere
Zyklus derselben (sitzungslangen) Instanz das alte Ergebnis. Das Overlay hat
neben „Neu anmelden" ein „Erneut versuchen" (stiller `forceRefresh`), weil
`onRefreshFailure` in authkit auch bei transienten WorkOS-429/5xx feuert —
ohne diesen Rückweg sperrt ein Blip die UI bis zum Full-Page-Redirect.
Dazu: `signIn({ state: { returnTo } })` + `onRedirectCallback` →
`router.history.replace` (nach `setTimeout(…, 0)`, sonst überschreibt das
SDK die Route), `returnTo` gegen Open Redirects validiert
(`lib/return-to.ts`), `onRefreshFailure` über die Modul-Bridge
`lib/session-expiry.ts` (der Provider hängt außerhalb des Routers),
`visibilitychange`-Refresh als Ersatz für das nicht durchgereichte
`onBeforeAutoRefresh`, optionales `VITE_WORKOS_API_HOSTNAME`
(AuthKit-Custom-Domain ⇒ First-Party-Cookies; leer = heutiges Verhalten).
Serverseitig: `verifyAccessToken` liefert `valid | invalid | unavailable` —
JWKS-/Netzfehler ⇒ 503 `AUTH_UNAVAILABLE`, nie 401; `clockTolerance: 30`;
401 tragen `code` + `WWW-Authenticate`; die Run-Route antwortet bei gültigem
JWT mit unbekannter/fehlender Org 403 (`UNKNOWN_ORG`/`NO_ORG`) statt 401.
