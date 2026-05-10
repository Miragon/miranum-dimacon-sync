import { createFileRoute, Link } from "@tanstack/react-router"
import { ElementBox, type ElementBoxProps } from "#/components/miranum/ElementBox"
import { MnTagline } from "#/components/miranum/MnTagline"

export const Route = createFileRoute("/")({ component: Dashboard })

interface AppTile {
  to: "/sync" | "/modules"
  no: string
  symbol: string
  name: string
  ig: string
  group?: ElementBoxProps["group"]
  description: string
}

const APPS: AppTile[] = [
  {
    to: "/sync",
    no: "01",
    symbol: "Cd",
    name: "Clockin · Dimacon",
    ig: "OPS",
    group: "ops",
    description: "Tagesplanung aus Dimacon nach Clockin synchronisieren.",
  },
  {
    to: "/modules",
    no: "02",
    symbol: "Md",
    name: "Module",
    ig: "UI",
    description: "Aktive und verfügbare Module dieser Installation.",
  },
]

function Dashboard() {
  return (
    <>
      <header className="mb-16">
        <MnTagline>Dashboard</MnTagline>
        <h1 className="text-h-display text-ink mt-6 max-md:text-[3rem]">Miranum.</h1>
        <p className="text-body-lg text-ink-2 mt-6 max-w-[580px]">
          App-Einstieg. Wähle eine Anwendung.
        </p>
      </header>

      <section>
        <h2 className="text-ink mb-6 font-mono text-[0.75rem] tracking-[0.18em] uppercase">Apps</h2>
        <div className="grid gap-6 md:grid-cols-2">
          {APPS.map((app) => (
            <AppCard key={app.to} app={app} />
          ))}
        </div>
      </section>
    </>
  )
}

function AppCard({ app }: { app: AppTile }) {
  return (
    <Link
      to={app.to}
      className="group focus-visible:outline-mn-accent block focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2"
    >
      <div className="border-rule group-hover:border-ink flex items-start gap-6 border p-5 transition-colors">
        <ElementBox
          no={app.no}
          symbol={app.symbol}
          name={app.name}
          ig={app.ig}
          group={app.group}
          size="md"
          className="shrink-0"
        />
        <div className="flex min-h-[152px] flex-1 flex-col">
          <h3 className="text-h-4 text-ink group-hover:text-mn-accent transition-colors">
            {app.name}
          </h3>
          <p className="text-body-sm text-ink-2 mt-2">{app.description}</p>
          <span className="text-ink-3 group-hover:text-ink mt-auto inline-flex items-center gap-1.5 font-mono text-[0.7rem] tracking-[0.18em] uppercase transition-colors">
            Öffnen <span aria-hidden>→</span>
          </span>
        </div>
      </div>
    </Link>
  )
}
