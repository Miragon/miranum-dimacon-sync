Miranum App Template — React SPA + Hono backend mit den Miranum-Clients
(ClockIn, Dimacon, Lexoffice).

## Architektur

```
src/
├── client/     React-SPA (TanStack Router, Tailwind, shadcn)
└── server/     Hono-Backend (proxy für die API-Clients)
    ├── lib/    env reader + lazy client singletons + settings
    ├── integrations/            Integrations-Registry (Mutex, Scheduler)
    │   ├── shared/              gemeinsame Loader/Helper (Dimacon, Zeit)
    │   ├── dimacon-clockin/     Tagesplanung Dimacon → Clockin
    │   └── dimacon-lexoffice/   Kunden-Sync Dimacon → Lexware Office
    └── routes/ /api/{clockin,dimacon,lexoffice,integrations,settings}/...
packages/clients/{clockin,dimacon,lexoffice}/  workspace packages
```

Der Backend-Server serviert die API-Routes unter `/api/...` und im Production-Build
auch die statischen Client-Assets aus `dist/client`. Im Dev läuft Vite separat
auf Port 3000 und proxied `/api` zum Backend auf Port 3020.

## Getting Started

```bash
pnpm install
cp env.example .env   # dann Werte eintragen
pnpm dev              # client (3000) + server (3020) parallel
```

## Environment

Beim Server-Start lädt `dotenv` die `.env` (gitignored) und reichert damit
`process.env` an — bereits gesetzte Werte werden **nicht** überschrieben.
Lokal kommt also alles aus `.env`, in Prod gewinnen `fly secrets`. Template:
[`env.example`](./env.example). Variablen:

| Variable                  | Beschreibung                                            | Pflicht |
| ------------------------- | ------------------------------------------------------- | ------- |
| `PORT`                    | Server-Port (default: 3020)                             | nein    |
| `CLOCKIN_API_TOKEN`       | ClockIn API Token                                       | ja\*    |
| `CLOCKIN_BASE_URL`        | ClockIn override                                        | nein    |
| `DIMACON_BASE_URL`        | Dimacon Base URL                                        | ja\*    |
| `DIMACON_TENANT`          | Dimacon Tenant                                          | ja\*    |
| `DIMACON_API_TOKEN`       | Dimacon API Token                                       | ja\*    |
| `LEXWARE_OFFICE_API_KEY`  | Lexoffice API Key                                       | ja\*    |
| `LEXWARE_OFFICE_BASE_URL` | Lexoffice override                                      | nein    |
| `SYNC_WEBHOOK_SECRET`     | Shared-Secret für alle `/run`-Webhooks (leer = offen)   | nein    |
| `SETTINGS_PATH`           | Pfad für Settings-JSON (default `./data/settings.json`) | nein    |
| `SYNC_CRON`               | Erst-Seed Cron für `dimacon-clockin` (danach UI)        | nein    |
| `SYNC_TZ`                 | Erst-Seed der Zeitzone (default `Europe/Berlin`)        | nein    |
| `WORKOS_CLIENT_ID`        | WorkOS Client ID (Backend, für JWKS). Leer = Auth aus.  | nein    |
| `VITE_WORKOS_CLIENT_ID`   | Gleicher Wert für SPA-Bundle. Leer = Auth-UI aus.       | nein    |
| `WORKOS_REQUIRED_ORG_ID`  | Org, deren `org_id` im Token akzeptiert wird            | nein    |

\* nur erforderlich wenn die jeweiligen `/api/<service>/...` Routes genutzt werden
(lazy validation beim ersten Request).

**Scheduler:** Jede Integration hat einen eigenen Cron (enabled, Ausdruck,
Timezone), **persistent in `SETTINGS_PATH`** (JSON, keyed nach Integration-ID)
und über die UI unter `/settings` editierbar. `SYNC_CRON` / `SYNC_TZ` werden
nur beim allerersten Start als Seed für `dimacon-clockin` verwendet; eine
Settings-Datei in der alten `{ "sync": ... }`-Form wird beim Laden automatisch
migriert. Für Fly: Volume an `/data` mounten und
`SETTINGS_PATH=/data/settings.json` setzen, damit Settings Redeploys überleben.

**Auth (WorkOS):** Wenn `WORKOS_CLIENT_ID` gesetzt ist, schützt eine
JWT-Middleware alle `/api/*`-Routes (außer den `run`/`healthz`-Endpoints unter
`/api/integrations/:id/...` und dem Legacy-Alias `/api/sync/...` — die
`run`-Webhooks haben ihr eigenes Secret). Tokens werden gegen die WorkOS-JWKS verifiziert,
zusätzlich wird `org_id === WORKOS_REQUIRED_ORG_ID` geprüft. Im Frontend bakt
Vite `VITE_WORKOS_CLIENT_ID` ins Bundle und das `<AuthKitProvider>` macht
Auth-Code-Flow mit PKCE. Im WorkOS-Dashboard müssen Redirect-URI **und**
Allowed-Origin auf die App-Origin gesetzt sein (z.B. `http://localhost:3000`
für Dev, `https://<flyapp>` für Prod). Sind die WorkOS-Vars leer, läuft die
App ohne Login und Backend loggt eine Warnung — nur für Dev gedacht.

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

### Removing Tailwind CSS

If you prefer not to use Tailwind CSS:

1. Remove the demo pages in `src/routes/demo/`
2. Replace the Tailwind import in `src/styles.css` with your own styles
3. Remove `tailwindcss()` from the plugins array in `vite.config.ts`
4. Uninstall the packages: `pnpm add @tailwindcss/vite tailwindcss --dev`

## Routing

This project uses [TanStack Router](https://tanstack.com/router) with file-based routing. Routes are managed as files in `src/routes`.

### Adding A Route

To add a new route to your application just add a new file in the `./src/routes` directory.

TanStack will automatically generate the content of the route file for you.

Now that you have two routes you can use a `Link` component to navigate between them.

### Adding Links

To use SPA (Single Page Application) navigation you will need to import the `Link` component from `@tanstack/react-router`.

```tsx
import { Link } from "@tanstack/react-router"
```

Then anywhere in your JSX you can use it like so:

```tsx
<Link to="/about">About</Link>
```

This will create a link that will navigate to the `/about` route.

More information on the `Link` component can be found in the [Link documentation](https://tanstack.com/router/v1/docs/framework/react/api/router/linkComponent).

### Using A Layout

In the File Based Routing setup the layout is located in `src/routes/__root.tsx`. Anything you add to the root route will appear in all the routes. The route content will appear in the JSX where you render `{children}` in the `shellComponent`.

Here is an example layout that includes a header:

```tsx
import { HeadContent, Scripts, createRootRoute } from "@tanstack/react-router"

export const Route = createRootRoute({
  head: () => ({
    meta: [
      { charSet: "utf-8" },
      { name: "viewport", content: "width=device-width, initial-scale=1" },
      { title: "My App" },
    ],
  }),
  shellComponent: ({ children }) => (
    <html lang="en">
      <head>
        <HeadContent />
      </head>
      <body>
        <header>
          <nav>
            <Link to="/">Home</Link>
            <Link to="/about">About</Link>
          </nav>
        </header>
        {children}
        <Scripts />
      </body>
    </html>
  ),
})
```

More information on layouts can be found in the [Layouts documentation](https://tanstack.com/router/latest/docs/framework/react/guide/routing-concepts#layouts).

## Server Functions

TanStack Start provides server functions that allow you to write server-side code that seamlessly integrates with your client components.

```tsx
import { createServerFn } from "@tanstack/react-start"

const getServerTime = createServerFn({
  method: "GET",
}).handler(async () => {
  return new Date().toISOString()
})

// Use in a component
function MyComponent() {
  const [time, setTime] = useState("")

  useEffect(() => {
    getServerTime().then(setTime)
  }, [])

  return <div>Server time: {time}</div>
}
```

## API Routes

You can create API routes by using the `server` property in your route definitions:

```tsx
import { createFileRoute } from "@tanstack/react-router"
import { json } from "@tanstack/react-start"

export const Route = createFileRoute("/api/hello")({
  server: {
    handlers: {
      GET: () => json({ message: "Hello, World!" }),
    },
  },
})
```

## Data Fetching

There are multiple ways to fetch data in your application. You can use TanStack Query to fetch data from a server. But you can also use the `loader` functionality built into TanStack Router to load the data for a route before it's rendered.

For example:

```tsx
import { createFileRoute } from "@tanstack/react-router"

export const Route = createFileRoute("/people")({
  loader: async () => {
    const response = await fetch("https://swapi.dev/api/people")
    return response.json()
  },
  component: PeopleComponent,
})

function PeopleComponent() {
  const data = Route.useLoaderData()
  return (
    <ul>
      {data.results.map((person) => (
        <li key={person.name}>{person.name}</li>
      ))}
    </ul>
  )
}
```

Loaders simplify your data fetching logic dramatically. Check out more information in the [Loader documentation](https://tanstack.com/router/latest/docs/framework/react/guide/data-loading#loader-parameters).

# Integrationen

Jede Integration ist ein in sich geschlossener Sync-Ablauf zwischen zwei der
angebundenen Systeme (Dimacon, Clockin, Lexware Office). Registriert in
`src/server/integrations/registry.ts` — damit bekommt sie automatisch eigenen
Mutex (max. ein Lauf gleichzeitig, sonst HTTP 409), eigenen Cron-Slot,
eigene HTTP-Routen und einen Eintrag in der UI (`/sync`, `/settings`).

| Integration         | Ablauf                                                                                                                                                                                                                                           |
| ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `dimacon-clockin`   | Tagesplanung: Termine laden, Projekte upserten, Mitarbeiter zuweisen, nicht Eingeplante archivieren. **Ohne Lexware-Abhängigkeit** — als Kundennummer dient die Dimacon-Nummer (Fallback: Dimacon-ID).                                           |
| `dimacon-lexoffice` | **Alle** Dimacon-Kunden mit Lexware Office abgleichen: fehlende Kontakte anlegen, Dimacon-Kundennummern an die Lexware-Nummern angleichen. Achtung: erster Live-Lauf legt fehlende Kontakte für den gesamten Bestand an — vorher dry-run prüfen. |

**Endpoints** (run/healthz offen — run per `SYNC_WEBHOOK_SECRET` geschützt,
Liste hinter Auth):

```bash
# Übersicht aller Integrationen (Auth)
curl http://localhost:3020/api/integrations

# On-Demand-Lauf (kein Body = heute, dryRun=false)
curl -X POST http://localhost:3020/api/integrations/dimacon-clockin/run

# Mit Datum + dryRun
curl -X POST http://localhost:3020/api/integrations/dimacon-lexoffice/run \
  -H "Content-Type: application/json" \
  -d '{ "date": "2026-05-09", "dryRun": true }'

# Webhook (wenn SYNC_WEBHOOK_SECRET gesetzt)
curl -X POST http://localhost:3020/api/integrations/dimacon-clockin/run \
  -H "Authorization: Bearer $SYNC_WEBHOOK_SECRET"

# Status einer Integration
curl http://localhost:3020/api/integrations/dimacon-clockin/healthz
```

`POST /api/sync/run` + `GET /api/sync/healthz` bleiben als **Legacy-Alias** für
`dimacon-clockin` erhalten (bestehende Webhooks funktionieren unverändert).

Scheduling: pro Integration über die UI (`/settings`) — persistiert in
`SETTINGS_PATH`, PUT auf `/api/settings/integrations/:id` restartet den
jeweiligen Cron hot. Fachliche Spezifikation der Tagesplanung:
`.context/attachments/SKILL.md`.

Architektur-Bausteine (`src/server/integrations/`):

- `types.ts` + `registry.ts` — IntegrationDefinition, Registrierung, zentraler Mutex-Wrapper
- `mutex.ts` — pro Integration max. ein Lauf (HTTP 409)
- `scheduler.ts` — ein `croner`-Cron pro Integration, hot-restartbar
- `shared/dimacon.ts` — gemeinsame Loader (Termine, Jobs, Kunden; parallel via `p-limit`)
- `dimacon-clockin/` — Orchestrator (fail-soft pro Projekt), Employee-Matching
  (Nachname → Vorname → E-Mail), Kunden-Upsert, Projekt-Upsert mit
  Mitarbeiter-Diff (attach/detach), Archivierung
- `dimacon-lexoffice/` — Lexware-Kontakt find-or-create + Kundennummern-Alignment

Tests laufen mit `pnpm test`.

# API Clients

Workspace-Packages unter `packages/clients/`:

- `@miranum/client-clockin` — ClockIn (`createClockInClient`)
- `@miranum/client-dimacon` — Dimacon (`createDimaconClient`)
- `@miranum/client-lexoffice` — Lexoffice (`createLexofficeClient`)

ClockIn und Dimacon werden via `@hey-api/openapi-ts` aus OpenAPI-Specs generiert
(`pnpm --filter @miranum/client-clockin generate`). Der `generate`-Schritt gibt
neben Typen + SDK auch Zod-Schemas (`src/generated/zod.gen.ts`) aus und läuft
danach die mitgelieferten Post-Processor unter `scripts/` (z. B.
`loosen-zod-optional.mjs`, `strip-zod-bigint.mjs`), die zu strikte Zod-Constraints
an das reale Backend-Verhalten anpassen. Der Lexoffice-Client ist
hand-geschrieben und nutzt Node's `Buffer` — daher Server-only.

Eingebunden im Backend über `src/server/lib/clients.ts` (lazy singletons aus
env-Variablen). Neue Endpoints werden in `src/server/routes/<service>.ts`
ergänzt — Beispiele: `GET /api/clockin/projects`, `GET /api/dimacon/me`,
`GET /api/lexoffice/profile`.

# Deployment

Dockerfile baut ein `node:22-alpine`-Image, läuft `tsx src/server/index.ts`
auf Port 3020. Health-Check unter `/healthz`. Tokens werden über `fly secrets`
gesetzt:

```bash
fly secrets set \
  CLOCKIN_API_TOKEN=… \
  DIMACON_BASE_URL=… DIMACON_TENANT=… DIMACON_API_TOKEN=… \
  LEXWARE_OFFICE_API_KEY=…
```

# Demo files

Files prefixed with `demo` can be safely deleted. They are there to provide a starting point for you to play around with the features you've installed.

# Learn More

You can learn more about all of the offerings from TanStack in the [TanStack documentation](https://tanstack.com).

For TanStack Start specific documentation, visit [TanStack Start](https://tanstack.com/start).
