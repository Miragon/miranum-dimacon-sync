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
  │   ├─ dimacon-lexoffice/ Kunden-Sync + Nummern-Alignment Dimacon → Lexware
  │   │                     (+ Opt-in-Übernahme Lexware → Dimacon)
  │   └─ dimacon-sevdesk/   Kunden-Sync + Nummern-Alignment Dimacon → sevDesk
  │                         (Spiegel des Lexoffice-Aligners, ohne Gegenrichtung)
  └─ routes/     /api/{clockin,dimacon,lexoffice,sevdesk,integrations,settings,
                 mappings,credentials,systems,me,tenants}/...
```

API-Clients kommen als externe npm-Deps
(`@miragon/client-{clockin,dimacon,lexoffice,sevdesk}`) aus dem Repo
Miragon/miranum-clients — hier nur konsumiert, nicht generiert. Der
sevDesk-Client ist wie der Lexoffice-Client handgeschrieben; sein
Authorization-Header trägt den ROHEN API-Token (kein `Bearer`-Präfix).

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
UI: Dimacon unter `/modules` (gemeinsames Quellsystem, Karte unter der
System-Tabelle), Clockin/Lexware/sevDesk auf der Einstellungsseite ihrer Integration
`/sync/<id>/settings` (Token-Feld immer leer; leer lassen = behalten). „Verbindung testen" POSTet die
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
  aktiven Mandanten aus `GET /api/systems`, plus die Dimacon-Zugangsdaten-Karte
  (`#dimacon-zugangsdaten`). Jede Tabellenzeile hat IMMER einen
  „bearbeiten"-Link (Dimacon → Anker auf derselben Seite, Zielsysteme →
  `/sync/<id>/settings?tab=zugangsdaten`) — vorher erschien der Weg nur im
  Fehlerzustand, ein hinterlegtes Token war von hier aus nicht änderbar. Die
  Credential-Karte rendert erst nach erfolgreichem `GET /api/credentials`,
  sonst behauptete sie bei einem Fehler „nicht konfiguriert"
- `/sync` — Integrations-Übersicht (Tabelle aller Integrationen mit Status)
- `/sync/$integrationId` — Detail: Run-Form (Datum, dryRun, Schritte —
  vorbelegt aus dem gespeicherten Umfang) + Result-View + Run-Historie;
  unbekannte Integrationen bekommen einen JSON-Fallback-Renderer
- **Kein** globaler „Einstellungen"-Nav-Punkt mehr: die frühere Seite
  `/settings` pflegte nur die Dimacon-Zugangsdaten und beantwortete damit
  dieselbe Frage wie die System-Tabelle. Zugangsdaten leben jetzt dort, wo
  auch ihr Status steht (`/modules` bzw. `/sync/<id>/settings`)
- `/sync/$integrationId/settings` — je Integration, erreichbar über das
  Zahnrad in der /sync-Tabelle, den Header-Link auf `/sync/$integrationId` und
  die „bearbeiten"-Spalte auf `/modules`: Tab-Menü
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
Routen `/api/integrations/:id/{run,healthz}` + Eintrag in `/sync`.
`requiredCredentials` (System-IDs) steuert den „konfiguriert"-Status je
Mandant (kein Crash — Run liefert 503 mit `missing`). Der
Dimacon→Clockin-Sync ist bewusst NICHT von Lexware abhängig.
`/api/sync/{run,healthz}` ist Legacy-Alias für `dimacon-clockin`.
`dimacon-sevdesk` spiegelt den Vorwärts-Teil von `dimacon-lexoffice`
(Auflösung Nummer→Name, `ambiguous`/`conflict` statt Schreibvorgang,
Voll-Index mit Serversuche-Fallback) für sevDesk: Kontakt-Anlage verteilt
sich auf `/Contact` + `/ContactAddress` + `/CommunicationWay` (Adresse/
Kommunikationswege best-effort), die Dimacon-Kundennummer wird beim Anlegen
geseedet, wenn sie in sevDesk nachweislich frei ist. Beim Nummern-Alignment
gilt weiter: **Dimacon-PUT ist ein Voll-Replace — ALLE geladenen Felder
inkl. `customAttributeValues` zurückspiegeln** (Test pinnt den kompletten
Body).

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
Discovery-API-Calls (Ausnahme `dimaconCustomer`, s. Übernahme unten). Match-Keys (project.number, customer.identifier,
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

Load-bearing Regeln des Mitarbeiter-Abgleichs: **Zugeordnet wird
ausschließlich über die Personalnummer** (`employee-sync/matcher.ts`), aktive
Dimacon-Mitarbeiter vor archivierten — auch die Tagesplanung
(`employees.ts`) sucht nur per `byPersonnelNumber`. Name/E-Mail als Schlüssel
haben Dubletten erzeugt: ein archivierter Alt-Datensatz ohne PNr griff sich
über den Namen den Clockin-Mitarbeiter, der aktive sollte daraufhin ein
zweites Mal in Clockin angelegt werden. Namen dienen nur noch als BREMSE vor
einer Anlage, nie zum Verknüpfen. Beide Anlage-Richtungen laufen durch
`employee-sync/creation-policy.ts` (Dimacon → Clockin: vollständiger
Personenname, PNr vorhanden und in Clockin unvergeben, kein namensähnlicher
ungepaarter Clockin-Datensatz). Die Anlage ist fail-closed: wurde der
Clockin-Bestand unvollständig geladen (`shared/clockin-pages.ts` paginiert
und meldet Abbruchgründe), legt der Lauf in KEINER Richtung Mitarbeiter an;
nicht angelegte Kandidaten erscheinen mit deutscher Begründung als
`skipped`-Zeile im Ergebnis. Nach Dimacon schreibt der Abgleich nur noch bei
einer Anlage (kein PNr-Backfill mehr) — wer wieder ein Mitarbeiter-PUT
einführt: das ist ein Voll-Replace, ALLE geladenen Felder zurückspiegeln,
sonst verlieren Mitarbeiter ihr Team (Issue #17).

Kunden-Lookup (`customers.ts`): die Kundennummer geht an den EXAKTEN Scope
`byIdentifier` (bzw. den vollständigen Index), erst danach an die unscharfe
`byNameOrNumber`-Suche. Mehrere exakte Treffer = Dublette in Clockin →
gemeldet, weder verknüpft noch angelegt. Nur unscharfe Treffer blockieren
NICHT (früher „nicht eindeutig" — der Kunde blieb dauerhaft unverknüpft und
seine Projekte wurden nie angelegt): ein einzelner gilt weiter als Treffer,
sofern er nicht einem anderen Dimacon-Kunden gehört; mehrere ⇒ Anlage plus
Hinweis mit den ähnlichen IDs. Ist die unscharfe Suche mehrseitig und gibt es
keine vollständige exakte Quelle, wird nicht angelegt (ein exakter Treffer
könnte auf Seite 2 liegen).

Übernahme Lexware → Dimacon (`dimacon-lexoffice`, Schritt
`importFromLexware`, **per Default AUS**): Kandidaten sind nur Kontakte mit
Angebot/Auftragsbestätigung der letzten `IMPORT_WINDOW_DAYS` (14) Tage
(`voucher-candidates.ts`, abgelehnt/storniert zählt nicht) — nie der
Gesamtbestand, der ist voller Alt- und Einmalkunden. Sie läuft im SELBEN Lauf
HINTER dem Vorwärts-Abgleich (ein Mutex; als eigene Integration könnten beide
Richtungen parallel denselben Kunden anlegen) und nimmt dessen Zuordnungen
(`claimed`) mit — im dry-run trägt der per Name gefundene Dimacon-Kunde die
Lexware-Nummer noch nicht. Schlüssel ist die Lexware-Kundennummer; angelegt
wird mit ihr und exakt `contactName()`, damit der nächste Vorwärts-Lauf in der
Nummernstufe trifft. `import-policy.ts` ist fail-closed: Nummer in Dimacon
fremd vergeben, gleich oder ähnlich benannter Dimacon-Kunde (loser Schlüssel
ohne Rechtsform — nur BREMSE, nie Verknüpfung), Namens-Dublette unter den
Kandidaten ⇒ `skipped` mit Begründung. Ohne VOLLSTÄNDIGEN Kontakt-Index oder
vollständige Belegliste legt der Lauf nichts an. Die Felder kommen aus der
Feld-Zuordnung `dimaconCustomer` („Dimacon-Kunde (aus Lexware)“ im
Feld-Zuordnungs-Tab): Quellen sind Lexware-Felder (`customer-body.ts`), Ziele
die Dimacon-Standardfelder plus die Kunden-Attribute über die Zielart
`attribute` (Clockin-Custom-Fields bleiben `custom`). Default = Adresse, erste
E-Mail/Telefonnummer; Name + Kundennummer sind fixiert. Auswahl-Attribute
(SELECT/MULTI_SELECT) sind bewusst KEINE Ziele (`WRITABLE_ATTRIBUTE_TYPES`) —
ob Dimacon beim Schreiben Wert-ID oder Label erwartet, ist ungeprüft. Für
`dimaconCustomer` lädt `loadMappingContext` die Discovery IMMER: ein aktives
Pflicht-Attribut (`isRequired`) ohne befüllbare Regel sperrt die Übernahme
für den Lauf (EIN Fehler mit Abhilfe statt je Kunde ein Dimacon-400), eine
leere Pflicht-Quelle macht den Kontakt zur `skipped`-Zeile.

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
`onBeforeAutoRefresh`.

**`onRefreshFailure` heilt still, bevor das Overlay kommt (load-bearing).**
Das Signal beweist NICHT, dass die Sitzung weg ist: authkit-js feuert es bei
JEDER nicht-ok-Antwort des Refresh-Endpunkts (429/5xx, Netz-Aussetzer,
verlorenes Rennen um ein rotiertes Token) und steht danach im ERROR-State, aus
dem es von sich aus nicht mehr refresht — das in-memory Access-Token lebt
derweil weiter. Live gemessen beim ALLERERSTEN Login: Overlay „Anmeldung nicht
erneuert" über einer vollständig geladenen, funktionierenden App; genau der
`forceRefresh` hinter „Erneut versuchen" hat es weggeräumt. Der AuthGate fährt
diesen Versuch deshalb selbst (`recoverOrExpire`), das Overlay erscheint nur
noch, wenn AUCH er scheitert. Wiedereintritts-Schutz (`healing`-Ref) ist Pflicht
— ein scheiternder `getAccessToken({ forceRefresh: true })` löst
`onRefreshFailure` erneut aus. Warum nur der erste Login auffällt:
`doRefresh` ruft `onRefreshFailure` NUR bei `beginningState.tag !== "INITIAL"`
— nach einem Reload läuft der wiederherstellende Refresh aus `INITIAL` und ein
Fehlschlag bleibt damit **stumm**; nach dem Callback steht der State schon auf
AUTHENTICATED. „Nach dem Reload weg" heißt also nicht „behoben". Und
`retrySession` protokolliert den Fehler, weil `onRefreshFailure` nur
`{ signIn }` bekommt und authkit-js selbst bloss `console.debug` schreibt (in
Chrome per Default ausgeblendet).

**Schleifenschutz um den Callback (load-bearing).** Scheitert der
Code-Tausch, fängt authkit-js den `CodeExchangeError` in `#handleCallback`
ab, meldet ihn NUR per `console.error` und lässt `user` auf `null` — die App
sah bisher einen normalen Abgemeldet-Zustand und leitete sofort wieder um
(Redirect → 500 → Redirect, leere Seite, keine Meldung). `lib/auth-callback.ts`
erfasst deshalb **beim Modul-Load** (`main.tsx` importiert es zusätzlich
explizit), ob die Seite mit `?code=` kam: authkit räumt die URL am Ende von
`#handleCallback` per `history.replaceState` selbst ab — ausserhalb des
try/catch —, im Render ist der Beleg also weg. Marker gesetzt + kein `user`
⇒ Fehlerzustand mit Button, **kein** Auto-signIn. Dazu zwei Bremsen: ein
`sessionStorage`-Zähler über Seitenaufrufe hinweg
(`MAX_AUTO_SIGN_IN_ATTEMPTS`, Serie = Abstand zum LETZTEN Versuch; Reset bei
jedem Erfolg und bei jedem Nutzer-Klick) und ein Ref je Seitenaufruf, damit
nie zwei Redirects parallel laufen (der zweite überschriebe den
PKCE-Verifier). Und **kein Dauerfeuer bei 401**: `createApiFetch` fragt vor
jedem Force-Refresh `auth.isSessionExpired()` (Ref im AuthGate, NICHT in den
useMemo-Deps und NICHT im Closure der Fabrik — ein geglückter Refresh
erzeugt in authkit-react ein neues `user`-Objekt und damit eine neue
apiFetch-Instanz, genau darüber lief die 401-Schleife). Freigabe nur durch
„Erneut versuchen" oder Reload — beide Richtungen des Refs sind in
`AuthGate.test.tsx` über den ECHTEN `apiFetch` aus dem Context gepinnt, weil
`api.test.ts` die Bremse nur gegen einen eigenen Stub prüfen kann. Der
Overlay-Text verspricht nichts über den Inhalt dahinter — bei dauerhaftem 401
steht dort nur der Ladezustand des TenantGate.

**Das Overlay nennt die Ursache, nicht die Wirkung.** `onSessionExpired`
trägt einen `SessionExpiredReason`: `refresh-failed` (Anmeldedienst — von
`onRefreshFailure` und von terminalen `getToken`-Fehlern) gegen
`server-rejected` (Refresh gelang, unser Backend weist das frische Token
trotzdem mit 401 ab — live gemessen: WorkOS 200, `/api/*` 401). Beide Fälle
haben eigenen Titel und Text; „Anmeldung nicht erneuert" im zweiten Fall war
nachweislich falsch und schickte den Betreiber zum falschen System. Der ZUERST
gemeldete Grund gewinnt (`markSessionExpired` kehrt bei gesetztem Ref sofort
zurück), sonst überschriebe ihn die Bremse selbst: die liefert ohne jeden
Refresh `terminal` und damit `refresh-failed`.

**Der AuthGate wartet auf den CLIENT, nicht auf den Benutzer** (`clientReady =
!isLoading && user`, load-bearing). Der AuthKitProvider hält Client und Session
in zwei getrennten States: `createClient()` ruft während seiner Initialisierung
schon `onRefresh` und setzt damit `user`, während `client` noch der
`NOOP_CLIENT` ist (`getAccessToken: () => Promise.reject(new
LoginRequiredError())`); `setClient(…)` und `isLoading: false` folgen erst im
`.then`. Wer in diesem Fenster einen API-Call startet, bekommt SOFORT einen
terminalen `LoginRequiredError` — ohne dass je ein Request rausgeht. Genau das
war das Overlay über der fertig geladenen App beim ersten Login (HAR:
sechs Requests, alle 200). Deshalb hängen `auth`/`apiFetch` UND der Render-Gate
an `clientReady`; die apiFetch-Identität wechselt dabei genau einmal, und zwar
bevor irgendein Consumer montiert ist. Die Warteanzeige in diesem Fenster heisst
„anmeldung wird vorbereitet …" — weitergeleitet wird gerade nichts.

**Wachhund über den authkit-Start** (`AUTH_INIT_TIMEOUT_MS`): `isLoading` kann
für immer `true` bleiben — authkit-react 0.16.1 ruft `createClient(...).then(...)`
OHNE `.catch()`, `isLoading: false` steht nur im Erfolgspfad. Lehnt
`createClient` ab (`JSON.parse(stateParam)` in `#handleCallback` liegt
ausserhalb des try/catch; gesperrter Site-Storage in `getRefreshToken`), greift
kein einziger Guard: der Callback-Befund oben hängt an `!isLoading`, der
Auto-signIn kehrt bei `isLoading` sofort zurück, und ein Reload reproduziert
alles, weil die URL-Bereinigung nie lief. Nach dem Timeout zeigt der AuthGate
deshalb einen Rückweg — und zwar `reloadWithoutAuthParams` (Seite ohne
Query-String neu), NICHT `signIn()`: der Provider liefert in dem Zustand noch
seinen NOOP-Client, dessen `signIn` ein leeres `async () => {}` ist.

**Wo der Refresh-Token liegt, entscheidet `VITE_WORKOS_API_HOSTNAME`**
(`lib/auth-flag.ts`): Nur eine AuthKit-Domain auf der EIGENEN Site
(`auth.example.com` neben der App auf `example.com`) macht die Cookies
First-Party — eine WorkOS-Domain (`*.authkit.app`) ist gegenüber der
App-Domain genauso Cross-Site wie `api.workos.com`, und auf `*.fly.dev` ist
die Konstellation gar nicht herstellbar (Public Suffix List). Ist die Variable
leer, setzt `main.tsx` deshalb `devMode` (= `WORKOS_KEEP_REFRESH_TOKEN_LOCALLY`):
authkit legt den Refresh-Token dann im `localStorage` ab und schickt ihn im
Request-Body. **Ohne das gibt es gar keinen Refresh** — authkit sendet den
Token weder im Body noch als Cookie, WorkOS antwortet `Missing refresh token`,
und die Sitzung stirbt, sobald das Access-Token abläuft (sie überlebt dann
auch keinen Reload, weil der Token sonst nur im RAM liegt). Preis: per XSS
auslesbar — der übliche SPA-Kompromiss; sicherer wäre ein eigenes
Auth-Backend (BFF), das ist ein Umbau, kein Schalter.
Serverseitig: `verifyAccessToken` liefert `valid | invalid | unavailable` —
JWKS-/Netzfehler ⇒ 503 `AUTH_UNAVAILABLE`, nie 401; `clockTolerance: 30`;
401 tragen `code` + `WWW-Authenticate`; die Run-Route antwortet bei gültigem
JWT mit unbekannter/fehlender Org 403 (`UNKNOWN_ORG`/`NO_ORG`) statt 401.
