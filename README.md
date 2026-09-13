Miranum App Template — React SPA + Hono backend mit den Miranum-Clients
(ClockIn, Dimacon, Lexoffice).

## Architektur

```
src/
├── client/     React-SPA (TanStack Router, Tailwind, shadcn)
└── server/     Hono-Backend (proxy für die API-Clients)
    ├── db/     Drizzle-Schema + Migrationen + Repos (Postgres) + Legacy-Seed
    ├── lib/    env reader + Tenant-Middleware + Crypto + Client-Factory
    ├── integrations/            Integrations-Registry (Mutex, Scheduler — je Mandant)
    │   ├── shared/              gemeinsame Loader/Helper (Dimacon, Zeit)
    │   ├── dimacon-clockin/     Tagesplanung Dimacon → Clockin
    │   └── dimacon-lexoffice/   Kunden-Sync Dimacon → Lexware Office
    └── routes/ /api/{clockin,dimacon,lexoffice,integrations,settings,mappings,credentials,systems,me,tenants}/...
```

**Multi-Mandanten-Modell:** Eine WorkOS-Organisation = ein Mandant. Der
`org_id`-Claim des JWT ist der Tenant-Schlüssel; die `tenants`-Tabelle in
Postgres ist die Zugangs-Allowlist (fail-closed — Anlage nur per Ops-Script,
kein HTTP-Endpoint):

```bash
TENANT_WEBHOOK_SECRET=<secret> pnpm exec tsx scripts/create-tenant.ts --org-id org_XXXX --name "Kunde GmbH"
```

(Webhook-Secret via Env, nicht als CLI-Argument — argv landet in Shell-History
und Prozessliste. Der `scripts/`-Ordner fährt im Docker-Image mit, damit die
Anlage per `fly ssh console` funktioniert.)

**Automatische Provisionierung (Org-Sync, optional):** Mit
`WORKOS_API_KEY` + `WORKOS_ORG_SYNC=on` provisioniert die App WorkOS-Orgs
selbst, denen das Feature-Flag **`dimacon-sync`** zugewiesen ist
(WorkOS-Dashboard → Feature Flags → `dimacon-sync` → Org als Target; je
Environment ein eigenes Flag-Targeting). PULL-only: ein Voll-Reconcile alle
2 Minuten (`src/server/tenant-sync.ts`) — kein neuer HTTP-Endpoint, die
Allowlist bleibt fail-closed. Semantik:

- Flag setzen ⇒ Mandant erscheint in ≤ ~2,5 min (aktiv, `managed_by='workos-sync'`,
  Name aus der Org; Umbenennungen werden nachgezogen).
- Flag entfernen ⇒ Deaktivierung nach zwei **zeitlich getrennten** Läufen
  ohne Flag (≈ ≤ 6 min; nie Löschung — Credentials/Zeitpläne überleben ein
  Re-Onboarding).
- Manuell angelegte Mandanten (`managed_by='manual'`) fasst der Sync NIE an;
  ein Flag auf so einer Org ist wirkungslos (Warnung im Log).
- **Not-Aus**: manuelles `active=false` per SQL wird vom Sync NICHT
  rückgängig gemacht (er reaktiviert nur eigene Deaktivierungen).
- Schutznetze: Abbruch bei unvollständiger/fremder Org-Liste (fängt u. a.
  Stage/Prod-Key-Verwechslung); Circuit-Breaker — sind mehr als 2 (oder über
  50 % der aktiven sync-Mandanten) Deaktivierungen fällig, wird der
  **komplette Lauf abgebrochen (0 ausgeführt)** und bleibt abgebrochen, bis
  jemand manuell prüft; Status in `app_meta['workos-org-sync']`;
  Staleness-Alarm im Log nach 24 h ohne erfolgreichen Lauf. Empfehlung:
  eigener WorkOS-API-Key nur für diese App (Rate-Limit-/Rotations-Isolation).

Alle Konfiguration liegt tenant-gescoped in Postgres: **API-Zugangsdaten**
(AES-256-GCM-verschlüsselt; Dimacon unter `/modules`, Clockin/Lexware in den
Integrations-Einstellungen `/sync/<id>/settings`), **Schedules**,
**Feld-Zuordnungen** und die **Run-Historie** (`sync_runs`, letzte 50 je
Mandant+Integration). Migrationen laufen automatisch beim Boot.

Die API-Clients kommen als npm-Packages (`@miragon/client-{clockin,dimacon,lexoffice}`)
aus [Miragon/miranum-clients](https://github.com/Miragon/miranum-clients).

Der Backend-Server serviert die API-Routes unter `/api/...` und im Production-Build
auch die statischen Client-Assets aus `dist/client`. Im Dev läuft Vite separat
auf Port 3000 und proxied `/api` zum Backend auf Port 3020.

## Getting Started

```bash
pnpm install
cp env.example .env   # dann Werte eintragen
pnpm stack:up         # lokales Postgres aus stack/docker-compose.yml (Host-Port 5400)
pnpm dev              # client (3000) + server (3020) parallel
```

Der Server migriert die DB beim Boot automatisch. Drizzle-Werkzeuge:
`pnpm db:generate` (Migration aus Schema-Änderung), `pnpm db:studio`
(DB-Browser).

**⚠️ `CREDENTIAL_KEYS` in Dev stabil halten:** Der Key in der `.env` muss
über Server-Neustarts hinweg derselbe bleiben. Wer den Server mit einem
Inline-Zufallskey startet (`CREDENTIAL_KEYS="1=$(openssl rand -base64 32)"`),
vergiftet die persistente Dev-DB: dort gespeicherte Tokens sind nach dem
Neustart nicht mehr entschlüsselbar („GCM-Authentifizierung fehlgeschlagen")
und müssen neu eingetragen werden.

## Environment

Beim Server-Start lädt `dotenv` die `.env` (gitignored) und reichert damit
`process.env` an — bereits gesetzte Werte werden **nicht** überschrieben.
Lokal kommt also alles aus `.env`, in Prod gewinnen `fly secrets`. Template:
[`env.example`](./env.example). Variablen:

| Variable                   | Beschreibung                                                                                                                      | Pflicht |
| -------------------------- | --------------------------------------------------------------------------------------------------------------------------------- | ------- |
| `PORT`                     | Server-Port (default: 3020)                                                                                                       | nein    |
| `DATABASE_URL`             | Postgres-URL (Dev-Default: docker-compose-DB)                                                                                     | prod    |
| `CREDENTIAL_KEYS`          | AES-Key-Ring `<id>=<base64-32B>,…` (links = aktueller Key)                                                                        | prod    |
| `WORKOS_CLIENT_ID`         | WorkOS Client ID (Backend, für JWKS). Leer = Auth aus (Dev).                                                                      | prod    |
| `VITE_WORKOS_CLIENT_ID`    | Gleicher Wert für SPA-Bundle (build-time). Leer = UI offen.                                                                       | prod    |
| `VITE_WORKOS_API_HOSTNAME` | AuthKit-Custom-Domain (z. B. `auth.example.com`, build-time). Macht Session-/Refresh-Cookie First-Party. Leer = `api.workos.com`. | nein    |
| `WORKOS_API_KEY`           | WorkOS-API-Key (`sk_…`, server-only): filtert die Switcher-Liste nach Org-Mitgliedschaft. Leer = nur aktiver Mandant.             | nein    |
| `WORKOS_ORG_SYNC`          | `on` = Org-Sync aktiv (Orgs mit Feature-Flag `dimacon-sync` werden automatisch provisioniert; braucht `WORKOS_API_KEY`).          | nein    |
| `RATE_LIMIT_<SYS>_RPS`     | Token-Bucket-Rate je Zielsystem (`DIMACON`/`CLOCKIN`/`LEXOFFICE`). Defaults: 10 / 5 / 2 Requests pro Sekunde.                     | nein    |
| `RATE_LIMIT_<SYS>_BURST`   | Sofort-Vorrat desselben Buckets. Defaults: 20 / 10 / 2.                                                                           | nein    |
| `CONCURRENCY_<SYS>`        | Parallele Tasks **je Phase**, nicht je Lauf (gemischte Tasks: strengstes System). Defaults: 8 / 5 / 2.                            | nein    |
| `ARCHIVE_HORIZON_DAYS`     | Planungshorizont des Archiv-Schutzes (±, Default 14 Tage) um heute **und** um das Sync-Datum: was darin einen Termin hat, bleibt. | nein    |

### Rate-Limits & Laufzeit

Jeder Lauf läuft in einem Metrik-Scope (`src/server/lib/metrics.ts`,
AsyncLocalStorage): Dauer und Request-Zahl je Phase und Zielsystem landen im
Log (`integration run metrics`) und als `metrics` im Ergebnis in
`sync_runs.result` — sichtbar unter `/sync/<id>` und robust gegen die
Größen-Kürzung großer Ergebnisse.

Gedrosselt wird proaktiv: ein Token-Bucket **je (Mandant, System)**
(`src/server/lib/rate-limit.ts`) hängt im Request-Interceptor von Dimacon und
Clockin bzw. im Lexware-Wrapper (`src/server/lib/client-instrumentation.ts`),
damit ein Mandant die anderen
nicht ausbremst. Die Defaults sind bewusst konservativ (Lexware Office
erlaubt laut Doku 2 Requests/Sekunde; die Limits von Dimacon und Clockin sind
nicht dokumentiert) und über die Variablen oben übersteuerbar — die Metriken
zeigen, ob mehr geht.

`CONCURRENCY_<SYS>` wirkt dagegen **je Phase**, nicht je Lauf: `createLimit`
baut an jeder Aufrufstelle ein eigenes `p-limit`, und Phasen, die der Lauf
bewusst nebeneinander fährt, addieren ihre Töpfe. Im dimacon-clockin-Lauf
läuft der Mitarbeiter-Abgleich neben der Tagesplanung — gleichzeitig offen
sind dort bis zu 2 × `CONCURRENCY_CLOCKIN` + 1 Clockin-Requests
(Stammdaten-Abgleich, Projekt-Vorabladung und die seitenweise
Kunden-Paginierung). Die Töpfe addieren sich auch ÜBER Systemgrenzen, weil
eine Task in Topf A Requests an System B absetzen darf: der
Personalnummer-Backfill sitzt im Clockin-Topf und schreibt nach Dimacon (er
hängt an keinem Schalter), also bis zu `CONCURRENCY_DIMACON` +
`CONCURRENCY_CLOCKIN` offene Dimacon-Requests auch ohne Opt-in — mit dem
Schritt „Mitarbeiter in Dimacon anlegen" kommt ein weiteres
`CONCURRENCY_DIMACON` dazu. Dazu die Sammelabrufe, die an keinem Limit
hängen. Die Phasen nach dem Zusammenführen (Projekt-Upserts, Archivierung)
laufen allein — dort gilt der Wert direkt. Laufweit bremst allein der
Token-Bucket: wer ein Zielsystem hart begrenzen muss, dreht an
`RATE_LIMIT_<SYS>_RPS`.

Bei einem Fehler hängt der Error-Interceptor `status`, `statusText`,
`retryAfterMs` und die (query-freie) URL an den geworfenen Fehler. Damit
wartet `withRetry` genau den vom Server genannten `Retry-After`-Wert
(gedeckelt auf 60 s) statt der früheren Pauschale von 20 s; ohne bzw. bei
unbrauchbarem Header (`0`, negativ, Datum in der Vergangenheit) greift eine
gestaffelte 5/10/20/30-s-Treppe mit Jitter. Ein 429 pausiert zusätzlich den
ganzen Bucket dieses Systems. Beides gilt nur für Dimacon und Clockin — der
handgeschriebene Lexware-Client hat keine Interceptoren.

Zwei bewusste Ausnahmen von der Wiederholung, beide in
`src/server/lib/concurrency.ts`: `NON_IDEMPOTENT_RETRY` an den `create*`-Aufrufen
(ein 5xx kann NACH dem Insert kommen — der Retry legte eine Dublette an, also
wird nur ein Rate-Limit wiederholt) und `NO_RATE_LIMIT_RETRY` an den
Lexware-Lookups (der Lexware-Client wiederholt 429 selbst; ohne die Ausnahme
werden aus einem logischen Aufruf ~20 HTTP-Calls). Weil diese client-internen
Wiederholungen am Wrapper vorbeilaufen, zählt `requests.lexoffice` sie nicht
mit — die Zahl ist die der logischen Aufrufe.

Lexware hängt deshalb allein an der proaktiven Drosselung
(`RATE_LIMIT_LEXOFFICE_RPS`, Default 2/s = das dokumentierte Limit) und an den
clienteigenen Wiederholungen: `wrapLexofficeClient` drosselt und zählt nur VOR
dem Request, ein 429 kommt als nackter `Error("Lexoffice API 429: …")` an und
pausiert den Bucket nicht. Erkannt wird er dort nur am Meldungstext
(`isRateLimited`, `src/server/lib/concurrency.ts`) — ein `status`-Feld gibt es
an diesem Fehler nicht.

### Bündelung statt Einzelabrufe

Beide Syncs lösen ihre Gegenstücke seit #15 über wenige Sammelabrufe statt
über einen Request je Element auf:

- **Dimacon**: `getAllJobsInPeriod` + `getCurrentTeamAssignments` +
  `getAllProjects` statt `getJobById`/`getProjectById` je Element; Kunden und
  Mitarbeiter werden ohnehin einmal als Gesamtbestand geladen und
  durchgereicht.
- **Clockin**: ein lokaler Kundenindex (`getAListOfCustomers`, paginiert) und
  eine gebündelte Projektsuche (`searchForProjects` mit mehreren Nummern und
  `includes: employees`) — damit entfällt auch das
  `getAListOfProjectEmployees` je Projekt.
- **Lexware**: ein paginierter Voll-Import von `/v1/contacts` statt einer
  Suche je Kunde.

Alle Bündelungen sind defensiv gebaut, weil das Verhalten der APIs an diesen
Stellen nicht dokumentiert ist: jede hat einen Einzelabruf-Fallback, die
Team-Zuweisungen werden je Lauf gegen `getJobById` geprobt (an einem zweiten
Auftrag, wenn der erste am Sync-Datum niemanden eingeplant hat — ist der Join
gar nicht belegbar, laufen die Einzelabrufe), und die gebündelte Projektsuche
schaltet auf Einzelanfragen um, wenn `byNumber` mehrere Parameter offenbar
nicht als ODER auswertet. Bleibt die ODER-Semantik dort mangels Treffer ganz
unbelegt, gilt eine Fehlanzeige nicht als Beweis: sie wird einzeln
nachgefragt, damit der Upsert kein Duplikat anlegt. Welcher Weg tatsächlich
genommen wurde, steht als `lookups` im Ergebnis (`sync_runs.result`) und im
Log. Indizes sind grundsätzlich **mehrwertig**: mehrere Kandidaten zu einem
Schlüssel bleiben sichtbar und führen wie bisher zu einer gemeldeten
Mehrdeutigkeit statt zu einem Schreibvorgang.

### Projekt-Startdatum und Archiv-Horizont

Zwei fachlich sichtbare Änderungen aus #15:

- Das Clockin-**Projekt-Startdatum** (`start_date`) wird nur noch bei der
  Anlage gesetzt und danach im Update-Body zurückgespiegelt. Vorher wurde es
  bei jedem Lauf auf das Sync-Datum gesetzt — damit war der Änderungsvergleich
  für jedes an einem anderen Tag synchronisierte Projekt per Definition wahr
  und praktisch jedes Projekt wurde täglich geschrieben.
- Die **Archiv-Phase** liest jetzt alle Seiten der unarchivierten Projekte
  (vorher nur die erste) und schreibt parallel. Damit das nicht in einer
  Massen-Archivierung endet, ist der Horizont-Schutz Pflicht: archiviert wird
  nur, was ±`ARCHIVE_HORIZON_DAYS` (Default 14) um **heute und** um das
  Sync-Datum **keinen** Termin hat — das Fenster reicht also von N Tagen vor
  dem früheren bis N Tage nach dem späteren der beiden Daten. Dass es immer
  auch über heute spannt, ist Absicht: `date` ist frei wählbar, und ein Lauf
  für ein vergangenes Datum würde sonst den heute eingeplanten Bestand
  archivieren. Kann der Horizont nicht ermittelt werden, archiviert
  der Lauf gar nichts und meldet das als Fehlerzeile — lieber zu wenig
  archivieren als auf halber Datenbasis. Denselben Fail-Safe gibt es bei
  unvollständiger Paginierung. **Vor dem ersten Live-Lauf nach diesem Update
  einen dryRun fahren und die Archiv-Liste abnehmen.**

**Nur noch Seed-Input** (einmaliger Import beim allerersten Boot gegen eine
leere DB — danach entfernen, siehe [`env.example`](./env.example)):
`WORKOS_REQUIRED_ORG_ID`, `CLOCKIN_API_TOKEN`, `CLOCKIN_BASE_URL`,
`DIMACON_BASE_URL`, `DIMACON_TENANT`, `DIMACON_API_TOKEN`,
`LEXWARE_OFFICE_API_KEY`, `LEXWARE_OFFICE_BASE_URL`, `SETTINGS_PATH`,
`SYNC_CRON`, `SYNC_TZ`, `SYNC_WEBHOOK_SECRET`, `SEED_TENANT_NAME`.
Die Integrations-Zugangsdaten werden zur Laufzeit verschlüsselt aus der DB
gelesen und je Mandant über die UI gepflegt (Dimacon: `/modules`,
Zielsysteme: `/sync/<id>/settings`); jedes Mitglied einer freigeschalteten
Org darf sie schreiben (bewusste Entscheidung — internes Ops-Tool).

**Key-Rotation:** neuen Key vorn an `CREDENTIAL_KEYS` anstellen → Redeploy →
`pnpm exec tsx src/server/db/rotate-credentials.ts` → prüfen, dass keine Zeile
mehr am alten Key hängt (`WHERE secret NOT LIKE 'v1:<neue id>:%'` = 0) → alten
Key entfernen. **Der Master-Key gehört zusätzlich in einen Passwort-Manager** —
bei Verlust müssen alle Mandanten ihre Tokens neu eintragen.

**Scheduler:** Jede Integration hat je Mandant einen eigenen Cron (enabled,
Ausdruck, Timezone), persistent in Postgres (`schedule_settings`), editierbar
im Zeitplan-Tab der Integrations-Einstellungen (`/sync/<id>/settings`).
Geplante Läufe fahren den **gespeicherten Umfang** aus
`schedule_settings.run_defaults` (Tab „Umfang", `?tab=umfang`) — leer heißt
weiterhin „alle Schritte, live", beim `dimacon-clockin`-Cron also inklusive
Live-Mitarbeiter-Abgleich (ohne die per Default abgeschaltete Anlage in
Dimacon). Das **Datum wird nie persistiert** (geplante Läufe sind immer
„heute"), der Umfang wird zur Feuerzeit gelesen (kein Cron-Restart nötig).
Sind gespeicherte Defaults ungültig (z. B. nach einer Schema-Änderung), wird
der Lauf **fail-closed übersprungen** statt mit vollem Umfang zu feuern —
`scheduled run skipped: invalid stored run defaults` im Log UND als Zeile mit
Status `skipped` in der Run-Historie. `skipped` heißt „nie gestartet" — der
geplante Lauf ist damit **ausgefallen**, die Ursache steht als Fehlermeldung in
derselben Zeile; Modus und Umfang sind NOT-NULL-Platzhalter und stehen unter
`/sync/<id>` deshalb als „—". Deaktivierte
Mandanten und fehlende Zugangsdaten werden zur Feuerzeit geprüft (Lauf wird
übersprungen, Warnung im Log).

**Auth (WorkOS):** Wenn `WORKOS_CLIENT_ID` gesetzt ist, schützt eine
JWT-Middleware alle `/api/*`-Routes (außer den `run`/`healthz`-Endpoints unter
`/api/integrations/:id/...` und dem Legacy-Alias `/api/sync/...`). Tokens
werden gegen die WorkOS-JWKS verifiziert; danach löst `resolveTenant` den
`org_id`-Claim gegen die `tenants`-Tabelle auf (unbekannte/inaktive Org ⇒ 403
mit Code `NO_ORG`/`UNKNOWN_ORG`/`ORG_INACTIVE`). Die `run`-Webhooks sind
Dual-Auth: ein **Mandanten-Webhook-Secret** (`x-sync-token` oder Bearer)
identifiziert den Mandanten direkt, alternativ zählt ein gültiges AuthKit-JWT
(UI-Pfad). Ohne identifizierbaren Mandanten ⇒ 401, fail-closed.
Unauthentifiziertes `healthz` liefert nur noch Liveness; der volle Status
braucht das Secret. Im Frontend bakt Vite `VITE_WORKOS_CLIENT_ID` ins Bundle
und das `<AuthKitProvider>` macht Auth-Code-Flow mit PKCE; der
Mandanten-Switcher im Header nutzt `switchToOrganization` und listet nur
Mandanten, deren Org der User laut WorkOS-Membership-API tatsächlich angehört
(`WORKOS_API_KEY`; ohne Key oder bei API-Fehlern nur den aktiven Mandanten —
nie alle). Im WorkOS-Dashboard
müssen Redirect-URI **und** Allowed-Origin auf die App-Origin gesetzt sein
(z.B. `http://localhost:3000` für Dev, `https://<flyapp>` für Prod). Sind die
WorkOS-Vars leer, läuft die App ohne Login mit einem lokalen Dev-Mandanten —
nur für Dev gedacht.

**Session-Robustheit:** Ein 401 wirft niemanden mehr ungefragt in den
Login-Redirect. `useApiFetch()` (`src/client/lib/api.ts`) holt bei 401 genau
einmal ein frisches Token (`getAccessToken({ forceRefresh: true })`) und
wiederholt den Request; parallele 401 teilen sich diesen Refresh
(Single-Flight — sonst überschreiben sich die PKCE-Code-Verifier im
sessionStorage). Erst wenn auch das scheitert, erscheint ein
„Anmeldung nicht erneuert"-Overlay mit Button; der Redirect passiert auf Klick, und
offene Formulareingaben bleiben erhalten, weil das Overlay nichts unmountet.
Ein Netzfehler ist dabei kein Sitzungsende: nur authkit-eigene Fehler
(`LoginRequiredError`) öffnen das Overlay, ein WLAN-Aussetzer erzeugt ein
normales Fehlerbanner. Und weil authkit auch bei einem transienten
WorkOS-429/5xx `onRefreshFailure` feuert, bietet das Overlay „Erneut
versuchen" an — ein stiller erzwungener Refresh, der die App ohne Redirect
und ohne Datenverlust wieder freigibt.
`signIn({ state: { returnTo } })` + `onRedirectCallback` bringen den Nutzer
danach auf seine Ursprungsroute zurück (`returnTo` wird gegen Open Redirects
validiert, s. `src/client/lib/return-to.ts`). Serverseitig trennt
`verifyAccessToken` transiente Fehler von ungültigen Tokens: JWKS-Timeout oder
Netzfehler ⇒ **503** `AUTH_UNAVAILABLE` (kein sinnloser Re-Login), ungültig ⇒
401 mit `code` (`TOKEN_MISSING`/`TOKEN_EXPIRED`/`TOKEN_INVALID`) plus
`WWW-Authenticate`; `jwtVerify` läuft mit `clockTolerance: 30` gegen Uhr-Drift
nach Standby. Auch `/api/integrations/:id/run` antwortet bei gültigem JWT mit
unbekannter/inaktiver Org mit **403** + Code statt 401.

## Building For Production

```bash
pnpm build       # vite build → dist/client
pnpm start       # tsx src/server/index.ts (serviert API + statics)
```

## Testing

This project uses [Vitest](https://vitest.dev/) for testing. You can run the tests with:

```bash
pnpm test
```

## Styling

This project uses [Tailwind CSS](https://tailwindcss.com/) for styling.

## Routing

TanStack Router mit file-based Routing — Route-Dateien liegen unter
`src/client/routes/` (Root-Layout `__root.tsx`, generierter Tree
`src/client/routeTree.gen.ts`).

# Integrationen

Jede Integration ist ein in sich geschlossener Sync-Ablauf zwischen zwei der
angebundenen Systeme (Dimacon, Clockin, Lexware Office). Registriert in
`src/server/integrations/registry.ts` — damit bekommt sie automatisch eigenen
Mutex (max. ein Lauf gleichzeitig, sonst HTTP 409), eigenen Cron-Slot,
eigene HTTP-Routen und einen Eintrag in der UI (`/sync`).

| Integration         | Ablauf                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| ------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `dimacon-clockin`   | Kompletter Clockin-Sync, Schritte per `steps` zuschaltbar: (1) **bidirektionaler** Mitarbeiter-Stammdaten-Abgleich über den gesamten Bestand (Dimacon gewinnt, Live-Lauf legt in Clockin fehlende Mitarbeiter dort an — vorher dry-run prüfen). Die Gegenrichtung **Clockin → Dimacon ist per Default AUS** und braucht `{"steps":{"employeeCreateInDimacon":true}}`; sie legt dann nur Mitarbeiter mit Personalnummer an, ohne ausgelaufene Verträge, ohne mehrdeutige/dublette und ohne namensähnliche Kandidaten — alles andere wird als `skipped`-Zeile mit Begründung gemeldet. Fail-Safe: wurde die Clockin-Mitarbeiterliste unvollständig geladen, legt der Lauf in **keiner** Richtung Mitarbeiter an. (2) Tagesplanung: Termine laden, Kunden/Projekte upserten, Mitarbeiter zuweisen, nicht Eingeplante archivieren. Der Kunden-Namens-Fallback (greift nur, wenn die Kundennummer nichts findet) wird gegen den **Dimacon-Gesamtbestand** abgesichert: gleichnamige Kunden und Treffer, deren Clockin-Identifier die Kundennummer eines anderen Dimacon-Kunden ist, werden nicht verknüpft; lädt der Bestand nicht, entfällt der Fallback ganz. **Ohne Lexware-Abhängigkeit.** |
| `dimacon-lexoffice` | **Alle** Dimacon-Kunden mit Lexware Office abgleichen: fehlende Kontakte anlegen, Dimacon-Kundennummern an die Lexware-Nummern angleichen. Auflösung erst über die (numerische) Kundennummer mit Namensplausibilisierung, dann über den exakten Namen (Firma ODER Privatperson) — jeweils nur gegen aktive Kunden-Kontakte, reine Lieferanten und archivierte Kontakte zählen nie als Treffer. Mehrdeutige Treffer und Namens-Duplikate im Dimacon-Bestand werden als `ambiguous`/`conflict` gemeldet statt geschrieben; fällt die Nummernsuche mit einem Fehler aus, wird in diesem Lauf kein Kontakt mehr angelegt. Achtung: erster Live-Lauf legt fehlende Kontakte für den gesamten Bestand an — vorher dry-run prüfen.                                                                                                                                                                                                                                                                                                                                                                                                                                                               |

**Endpoints** (run/healthz offen — `run` ist Dual-Auth: Mandanten-Webhook-
Secret oder AuthKit-JWT, Liste hinter Auth):

```bash
# Übersicht aller Integrationen (Auth, inkl. gespeichertem Umfang)
curl http://localhost:3020/api/integrations

# Run-Historie einer Integration (Auth, tenant-gescopt, ?limit=1..50)
curl http://localhost:3020/api/integrations/dimacon-clockin/runs

# Gespeicherten Umfang setzen (Auth) — gilt für Cron, UI und Webhook
curl -X PUT http://localhost:3020/api/settings/integrations/dimacon-clockin/run-defaults \
  -H "Content-Type: application/json" \
  -d '{ "runDefaults": { "dryRun": false, "steps": { "employees": false } } }'

# On-Demand-Lauf (kein Body = heute + gespeicherter Umfang)
curl -X POST http://localhost:3020/api/integrations/dimacon-clockin/run

# Mit Datum + dryRun (nur dimacon-clockin kennt `date`)
curl -X POST http://localhost:3020/api/integrations/dimacon-clockin/run \
  -H "Content-Type: application/json" \
  -d '{ "date": "2026-05-09", "dryRun": true }'

# dimacon-lexoffice läuft immer über den gesamten Kundenstamm — nur `dryRun`
curl -X POST http://localhost:3020/api/integrations/dimacon-lexoffice/run \
  -H "Content-Type: application/json" \
  -d '{ "dryRun": true }'

# Webhook (per-Mandant-Secret — gesetzt bei der Anlage via scripts/create-tenant.ts)
curl -X POST http://localhost:3020/api/integrations/dimacon-clockin/run \
  -H "x-sync-token: $TENANT_WEBHOOK_SECRET"

# Status einer Integration
curl http://localhost:3020/api/integrations/dimacon-clockin/healthz
```

`POST /api/sync/run` + `GET /api/sync/healthz` bleiben als **Legacy-Alias** für
`dimacon-clockin` erhalten. **Achtung**: ein Aufruf ohne Body fährt den
**gespeicherten Umfang** des Mandanten; ist keiner gesetzt, ist das wie bisher
der komplette Schritt-Satz inklusive **Live-Mitarbeiter-Abgleich** (legt in
Clockin fehlende Mitarbeiter dort an). Ein mitgeschickter Body überschreibt den
gespeicherten Umfang feldweise (`steps` wird eine Ebene tief gemerged, gilt nur
für diesen Lauf) — nur Tagesplanung also weiterhin mit
`{ "steps": { "employees": false } }`, dauerhaft besser über den Umfang-Tab.
Die Anlage in **Dimacon** läuft nicht mit: sie ist seit Issue #17 per Default
aus und muss mit `{ "steps": { "employeeCreateInDimacon": true } }` bzw. im
Umfang-Tab ausdrücklich angefordert werden.

Scheduling: pro (Mandant, Integration) im Zeitplan-Tab der
Integrations-Einstellungen (`/sync/<id>/settings`, Zahnrad in der
/sync-Tabelle). Der Editor ist Picker-basiert (Täglich mit Uhrzeit und
Wochentagen, Intervall mit kuratierten Rhythmen, Experten-Modus fürs rohe
Cron-Feld) und übersetzt client-seitig nach Cron — persistiert wird weiter
der Cron-String in Postgres (`schedule_settings`), PUT auf
`/api/settings/integrations/:id` restartet den jeweiligen Cron hot.
Fachliche Spezifikation der Tagesplanung: `.context/attachments/SKILL.md`.

**Umfang (Run-Defaults):** Im Tab „Umfang" der Integrations-Einstellungen
(`/sync/<id>/settings?tab=umfang`) wird festgelegt, welche Schritte laufen und
ob dauerhaft `dryRun` gilt — persistiert als `schedule_settings.run_defaults`
(jsonb, je Mandant + Integration), serverseitig gegen das `inputSchema` der
Integration validiert und normalisiert gespeichert. Der Wert gilt für **alle**
Auslöser (Cron, manuelles Formular, Webhook); das manuelle Formular ist damit
vorbelegt, Abweichungen dort gelten nur für den einzelnen Lauf. Ein Datum wird
nie gespeichert. Weil normalisiert (expandiert) gespeichert wird, wirken
spätere Änderungen an den Schema-Defaults nicht mehr auf bereits
konfigurierte Mandanten. `GET /api/integrations/:id/runs` liefert die letzten
Läufe (Auslöser, Modus, Umfang, Status) — dieselbe Tabelle steht unter
`/sync/<id>` unter dem Ergebnis.

**Feld-Zuordnung:** Im Tab „Feld-Zuordnung" der Integrations-Einstellungen
(`/sync/<id>/settings?tab=mapping`) lässt sich per Drag & Drop
konfigurieren, welche Dimacon-Felder (inkl. Custom-Attribute) in welche
Zielfelder (inkl. Clockin-Custom-Felder) geschrieben werden — API:
`/api/mappings/:id[/:entity]`, persistiert in Postgres (`field_mappings`).
Ohne gespeicherte Zuordnung gelten Default-Regeln, die dem bisherigen
Verhalten entsprechen; Match-Keys sind fixiert.

Architektur-Bausteine (`src/server/integrations/`):

- `types.ts` + `registry.ts` — IntegrationDefinition, Registrierung, zentraler Mutex-Wrapper
- `mutex.ts` — pro Integration max. ein Lauf (HTTP 409)
- `scheduler.ts` — ein `croner`-Cron pro Integration, hot-restartbar
- `shared/dimacon.ts` — gemeinsame Loader (Termine, Jobs, Kunden; parallel via `p-limit`)
- `shared/clockin-pages.ts` — Paginierung der Clockin-Listen (`page`-Query ab
  Seite 2) samt Abbruchwächtern; meldet eine unvollständige Liste als
  `complete:false` mit Grund, statt still zu kürzen
- `shared/field-{catalog,mapping}.ts` + `mapping-context.ts` — Feld-Zuordnungs-Framework
  (Katalog, pure Engine, Discovery von Custom-Attributen/-Feldern)
- `dimacon-clockin/` — Orchestrator (fail-soft pro Projekt), Employee-Matching
  (Nachname → Vorname → E-Mail), Kunden-Upsert, Projekt-Upsert mit
  Mitarbeiter-Diff (attach/detach), Archivierung; `employee-sync/` darin ist
  der bidirektionale Stammdaten-Abgleich (Matching Personalnummer → E-Mail →
  Name, Dimacon gewinnt, Personalnummer-Backfill mit Voll-Replace-Body) als
  erster Schritt; `employee-sync/creation-policy.ts` entscheidet den
  Relevanzfilter der Anlage Clockin → Dimacon
- `dimacon-lexoffice/` — Lexware-Kontakt find-or-create + Kundennummern-Alignment.
  Auflösung: numerische Kundennummer (mit Namensplausibilisierung) → exakter
  Name (Firma oder Privatperson); mehrdeutige Treffer und Namens-Duplikate im
  Dimacon-Bestand werden als `ambiguous`/`conflict` gemeldet statt
  geschrieben. Die Lookup-Schicht liegt isoliert in
  `dimacon-lexoffice/contact-lookup.ts` und liefert nur aktive
  Kunden-Kontakte (keine Lieferanten, keine archivierten)

Tests laufen mit `pnpm test`.

# API Clients

npm-Packages aus [Miragon/miranum-clients](https://github.com/Miragon/miranum-clients):

- `@miragon/client-clockin` — ClockIn (`createClockInClient`)
- `@miragon/client-dimacon` — Dimacon (`createDimaconClient`)
- `@miragon/client-lexoffice` — Lexoffice (`createLexofficeClient`)

ClockIn und Dimacon werden via `@hey-api/openapi-ts` aus OpenAPI-Specs generiert,
der Lexoffice-Client ist hand-geschrieben und nutzt Node's `Buffer` — daher
Server-only. Generierung und Release passieren im miranum-clients-Repo; hier
werden die Packages nur konsumiert.

Eingebunden im Backend über `src/server/lib/clients.ts` — eine per-Mandant-
Factory (`getClientsForTenant`), die die verschlüsselten Zugangsdaten aus
Postgres liest und Clients je (Mandant, System) cached. Neue Endpoints werden
in `src/server/routes/<service>.ts` ergänzt — Beispiele:
`GET /api/clockin/projects`, `GET /api/dimacon/me`, `GET /api/lexoffice/profile`
(manuelle Verifikations-Endpoints gegen die GESPEICHERTEN Zugangsdaten).
Das „Verbindung testen" der UI läuft über `POST /api/credentials/:system/test`
und prüft die Formularwerte VOR dem Speichern: Wegwerf-Client via
`src/server/lib/connection-test.ts`, leeres Token = gespeichertes Secret;
persistiert nichts.

# Deployment

Dockerfile baut ein `node:22-alpine`-Image, läuft `tsx src/server/index.ts`
auf Port 3020. Health-Check unter `/healthz`. Beim Boot laufen die
Drizzle-Migrationen (der Ordner `src/server/db/migrations` fährt im Image mit)
und — gegen eine leere DB — der einmalige Legacy-Seed. Laufzeit-Secrets:

```bash
fly secrets set \
  DATABASE_URL="postgres://…" \
  CREDENTIAL_KEYS="1=$(openssl rand -base64 32)" \
  WORKOS_CLIENT_ID=client_… \
  WORKOS_API_KEY=sk_…
```

**Image-Build + Ausrollen (CI, manuell ausgelöst):** Deployments laufen
ausschließlich über GitHub Actions → „Build and Deploy to Fly" → _Run
workflow_: Branch wählen (bestimmt den gebauten Stand) + `target` =
`prod`/`stage` (für beide Umgebungen zweimal auslösen). Ein Merge auf `main`
deployt **nichts**. Der Workflow baut das Image, pusht es nach
`registry.fly.io/<app>` (getaggt `latest` + Commit-SHA) und deployt es
anschließend (`flyctl deploy` mit der eingecheckten `fly.toml`,
`--ha=false` = genau **eine** Machine — in-process Cron + Mutex).
Voraussetzung: die Laufzeit-Secrets der App sind gesetzt, sonst verweigert
der Produktions-Guard den Start und der Health-Check lässt den Deploy
fehlschlagen. Auch der **allererste** Deploy einer App funktioniert über die
Pipeline (sie erzeugt die erste Machine). Manueller Fallback bleibt möglich:

```bash
fly deploy -a <app> -i registry.fly.io/<app>:<git-sha> --ha=false
```

**Rollout-Reihenfolge (Stage zuerst, dann Prod):**

1. Fly-Postgres anlegen, `DATABASE_URL` + `CREDENTIAL_KEYS` setzen
   (**Key-Kopie in den Passwort-Manager!**). Bestehende Secrets + Volume
   unangetastet lassen — sie sind der Seed-Input und der Rollback-Pfad.
2. Neues Image ausrollen (`fly deploy -a … -i …`, s. o.). Der Boot-Seed importiert Tenant
   (aus `WORKOS_REQUIRED_ORG_ID`), Env-Credentials (verschlüsselt),
   settings.json-Schedules/Zuordnungen und den `SYNC_WEBHOOK_SECRET`-Hash.
   Seed-Log prüfen (`legacy seed complete`).
3. Verifizieren: Login (Chip „Mandant · …"), `/modules` (Dimacon) +
   `/sync/<id>/settings` (Zielsysteme) — „hinterlegt am …" + 3× Verbindung
   testen, dryRun, Webhook mit altem `x-sync-token`.
4. Nach Bake-Fenster: `fly secrets unset CLOCKIN_API_TOKEN DIMACON_API_TOKEN
DIMACON_BASE_URL DIMACON_TENANT LEXWARE_OFFICE_API_KEY
WORKOS_REQUIRED_ORG_ID SYNC_CRON SYNC_TZ SYNC_WEBHOOK_SECRET` — der
   Env-Cleanup ist ein **Korrektheits-Gate**: solange die Alt-Secrets liegen,
   würde ein DB-Reset veraltete Tokens re-importieren. Danach Volume +
   `SETTINGS_PATH` entfernen; ab hier ist kein Rollback auf Vor-Postgres-Builds
   mehr möglich.

**Produktions-Guard**: mit `NODE_ENV=production` startet der Server nur, wenn
`WORKOS_CLIENT_ID`, `DATABASE_URL` **und** `CREDENTIAL_KEYS` gesetzt sind
(sonst klare Fehlermeldung beim Boot). Die offenen `run`-Webhooks sind
strukturell fail-closed: ohne per-Mandant-Secret-Treffer oder gültiges JWT
immer 401. Im Dev bleibt der offene Fallback (Dev-Mandant, Warnung im Log)
erhalten. **Single-Machine-Constraint bleibt bestehen** (in-process Cron +
prozesslokaler Mutex) — nicht auf 2 Machines skalieren.

**⚠️ `VITE_WORKOS_CLIENT_ID` wird zur Build-Zeit ins Bundle gebakt** — ein
Fly-Secret kann Frontend-Auth NICHT aktivieren. Der Deploy-Workflow
(`.github/workflows/deploy.yml`) übergibt den Wert als
Docker-Build-Arg aus den GitHub-**Secrets** `WORKOS_CLIENT_ID_PROD`
bzw. `WORKOS_CLIENT_ID_STAGE` (inhaltlich eine Public-Client-ID; pro
Umgebung ein eigener WorkOS-Client). Lokal: `docker build --build-arg
VITE_WORKOS_CLIENT_ID=client_…`.

Dasselbe gilt für die optionale `VITE_WORKOS_API_HOSTNAME` — sie kommt als
GitHub-**Variable** (`vars`, kein Secret: ein Hostname ist nicht geheim)
`WORKOS_API_HOSTNAME_PROD` bzw. `WORKOS_API_HOSTNAME_STAGE` ins Build-Arg.
Nicht gesetzt = leerer String = heutiges Verhalten. Ein falscher Hostname
(Custom-Domain im Dashboard noch nicht verifiziert) legt die Anmeldung lahm
und ist nur per Rebuild korrigierbar — Rollout deshalb getrennt vom Merge.

WorkOS-Dashboard-Checkliste **pro Umgebung** (eigener Client für prod/stage):

- Redirect-URI = exakt die App-Origin (z. B. `https://miranum-dimacon-sync.fly.dev`) —
  AuthKit nutzt standardmäßig `window.location.origin` als Redirect-Ziel.
- Dieselbe Origin als Allowed Origin (CORS) eintragen.
- **AuthKit-Custom-Domain** (z. B. `auth.<eigene-domain>`) einrichten, sobald
  die App unter einer eigenen Domain läuft: ohne sie liegt das Session-Cookie
  bei `api.workos.com` und ist aus Sicht der App Cross-Site — jeder Reload
  läuft dann still über die Hosted-Login-Seite und der Refresh ist in
  Safari/Firefox/Inkognito fragil. Mit Custom-Domain den Hostnamen als
  `VITE_WORKOS_API_HOSTNAME` bauen und Redirect-URI/Allowed-Origin auch dort
  pflegen. Auf `*.fly.dev` ist das nicht lösbar (fly.dev steht auf der Public
  Suffix List).
- Client-ID sowohl als Fly-Secret (`WORKOS_CLIENT_ID`, Backend/JWKS) als auch
  als GitHub-Secret (`WORKOS_CLIENT_ID_*`, Frontend-Build) hinterlegen.
- Einen environment-scoped API-Key erzeugen (Dashboard → API Keys, `sk_…`)
  und NUR als Fly-Secret setzen
  (`fly secrets set -a miranum-dimacon-sync[-stage] WORKOS_API_KEY=sk_…`) —
  nie als GitHub-Variable oder Build-Arg. Ohne den Key zeigt der
  Mandanten-Switcher nur den aktiven Mandanten.
