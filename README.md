Miranum App Template — React SPA + Hono backend mit den Miranum-Clients
(ClockIn, Dimacon, Lexoffice).

## Architektur

```
src/
├── client/     React-SPA (TanStack Router, Tailwind, shadcn)
└── server/     Hono-Backend (proxy für die API-Clients)
    ├── lib/    env reader + lazy client singletons
    └── routes/ /api/{clockin,dimacon,lexoffice}/...
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

| Variable                   | Beschreibung                                               | Pflicht |
| -------------------------- | ---------------------------------------------------------- | ------- |
| `PORT`                     | Server-Port (default: 3020)                                | nein    |
| `CLOCKIN_API_TOKEN`        | ClockIn API Token                                          | ja\*    |
| `CLOCKIN_BASE_URL`         | ClockIn override                                           | nein    |
| `DIMACON_BASE_URL`         | Dimacon Base URL                                           | ja\*    |
| `DIMACON_TENANT`           | Dimacon Tenant                                             | ja\*    |
| `DIMACON_API_TOKEN`        | Dimacon API Token                                          | ja\*    |
| `LEXWARE_OFFICE_API_KEY`   | Lexoffice API Key                                          | ja\*    |
| `LEXWARE_OFFICE_BASE_URL`  | Lexoffice override                                         | nein    |
| `SYNC_WEBHOOK_SECRET`      | Shared-Secret für `POST /api/sync/run` (leer = offen)      | nein    |
| `SETTINGS_PATH`            | Pfad für Settings-JSON (default `./data/settings.json`)    | nein    |
| `SYNC_CRON`                | Initial-Seed des Cron-Ausdrucks (danach UI-konfigurierbar) | nein    |
| `SYNC_TZ`                  | Initial-Seed der Zeitzone (default `Europe/Berlin`)        | nein    |
| `WORKOS_CLIENT_ID`         | WorkOS Client ID (Backend, für JWKS). Leer = Auth aus.     | nein    |
| `VITE_WORKOS_CLIENT_ID`    | Gleicher Wert für SPA-Bundle. Leer = Auth-UI aus.          | nein    |
| `WORKOS_REQUIRED_ORG_ID`   | Org, deren `org_id` im Token akzeptiert wird               | nein    |
| `VITE_WORKOS_API_HOSTNAME` | Eigene AuthKit-Domain (z.B. `…-staging.authkit.app`)       | nein    |

\* nur erforderlich wenn die jeweiligen `/api/<service>/...` Routes genutzt werden
(lazy validation beim ersten Request).

**Sync-Scheduler:** Cron-Ausdruck und Timezone werden **persistent in
`SETTINGS_PATH`** (JSON) gehalten und über die UI unter `/settings` editiert.
`SYNC_CRON` / `SYNC_TZ` werden nur beim ersten Start als Seed verwendet, falls
das Settings-File noch nicht existiert. Für Fly: Volume an `/data` mounten und
`SETTINGS_PATH=/data/settings.json` setzen, damit Settings Redeploys überleben.

**Auth (WorkOS):** Wenn `WORKOS_CLIENT_ID` gesetzt ist, schützt eine
JWT-Middleware alle `/api/*`-Routes (außer `/api/sync/healthz` + `/api/sync/run` —
Webhook hat eigenes Secret). Tokens werden gegen die WorkOS-JWKS verifiziert,
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

# Sync (Dimacon → Clockin)

Überträgt die Tagesplanung aus Dimacon nach Clockin. Logik in `src/server/sync/`,
HTTP-Route in `src/server/routes/sync.ts`. Siehe `.context/attachments/SKILL.md`
für die fachliche Spezifikation.

**Drei Trigger, ein Endpoint** (`POST /api/sync/run`):

```bash
# On-Demand (kein Body = heute, dryRun=false)
curl -X POST http://localhost:3020/api/sync/run

# Mit Datum + dryRun
curl -X POST http://localhost:3020/api/sync/run \
  -H "Content-Type: application/json" \
  -d '{ "date": "2026-05-09", "dryRun": true }'

# Webhook (wenn SYNC_WEBHOOK_SECRET gesetzt)
curl -X POST http://localhost:3020/api/sync/run \
  -H "Authorization: Bearer $SYNC_WEBHOOK_SECRET"

# Cron — Schedule wird in `SETTINGS_PATH` persistiert und über die UI
# (`/settings`) editiert. Erst-Seed optional via Env beim ersten Start:
SYNC_CRON="0 6 * * *" SYNC_TZ="Europe/Berlin" pnpm start
```

Response: `SyncResult` mit Listen `projects` (created / updated / unchanged /
skipped / failed), `archived` und `errors`. Status-Endpoint:
`GET /api/sync/healthz` zeigt ob ein Lauf gerade aktiv ist.

Architektur-Bausteine:

- `sync/index.ts` — Orchestrator, fail-soft pro Projekt
- `sync/appointments.ts` + `sync/enrichment.ts` — Daten laden (parallel via `p-limit`)
- `sync/employees.ts` — Match Nachname → Vorname → E-Mail (mit In-Run-Cache)
- `sync/customers.ts` — 3-Wege-Sync Dimacon ↔ Lexware ↔ Clockin
- `sync/projects.ts` — Search-before-create, Mitarbeiter-Diff (attach/detach)
- `sync/archive.ts` — Nicht-eingeplante Projekte archivieren
- `sync/mutex.ts` — Verhindert parallele Läufe (HTTP 409)
- `sync/scheduler.ts` — `croner` In-Process-Scheduler

Tests laufen mit `pnpm test`.

# API Clients

Workspace-Packages unter `packages/clients/`:

- `@miranum/client-clockin` — ClockIn (`createClockInClient`)
- `@miranum/client-dimacon` — Dimacon (`createDimaconClient`)
- `@miranum/client-lexoffice` — Lexoffice (`createLexofficeClient`)

ClockIn und Dimacon werden via `@hey-api/openapi-ts` aus OpenAPI-Specs generiert
(`pnpm --filter @miranum/client-clockin generate`). Der Lexoffice-Client ist
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
