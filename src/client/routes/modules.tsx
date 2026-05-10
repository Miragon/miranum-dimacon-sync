import { createFileRoute } from "@tanstack/react-router"
import { ElementBox } from "#/components/miranum/ElementBox"
import { MnStatusBadge } from "#/components/miranum/MnStatusBadge"
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "#/components/ui/table"
import { MIRANUM_ELEMENTS } from "#/lib/elements"

export const Route = createFileRoute("/modules")({ component: Modules })

const ACTIVE_SYMBOLS = new Set(["Dm", "Mc"])

function Modules() {
  const modules = MIRANUM_ELEMENTS.filter((e) => e.group)

  return (
    <>
      <header className="mb-12">
        <span className="mn-mono">/modules · portal</span>
        <h1 className="text-h-1 text-ink mt-4">Module</h1>
        <p className="text-body text-ink-2 mt-3 max-w-[540px]">
          Aktive und verfügbare Module. Ein Klick zum Konfigurieren.
        </p>
      </header>

      <section className="mb-16">
        <h2 className="text-ink mb-6 font-mono text-[0.75rem] tracking-[0.18em] uppercase">
          Übersicht
        </h2>
        <div className="grid gap-4 md:grid-cols-2">
          {modules.map((m) => (
            <div key={m.symbol} className="flex items-center gap-5">
              <ElementBox
                no={m.no}
                symbol={m.symbol}
                name={m.name}
                ig={m.ig}
                group={m.group}
                size="sm"
              />
              <div>
                <h3 className="text-h-4 text-ink">{m.name}</h3>
                {m.description ? <p className="text-body-sm mt-0.5">{m.description}</p> : null}
              </div>
            </div>
          ))}
        </div>
      </section>

      <section>
        <h2 className="text-ink mb-6 font-mono text-[0.75rem] tracking-[0.18em] uppercase">
          Aktivierung
        </h2>
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead className="w-16">No.</TableHead>
              <TableHead className="w-20">Symbol</TableHead>
              <TableHead>Modul</TableHead>
              <TableHead>Gruppe</TableHead>
              <TableHead className="w-32">Status</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {modules.map((m) => (
              <TableRow key={m.symbol}>
                <TableCell>
                  <span className="mn-mono mn-mono-accent">{m.no}</span>
                </TableCell>
                <TableCell className="font-semibold">{m.symbol}</TableCell>
                <TableCell>{m.name}</TableCell>
                <TableCell className="text-ink-2">{m.description}</TableCell>
                <TableCell>
                  {ACTIVE_SYMBOLS.has(m.symbol) ? (
                    <MnStatusBadge variant="ok">Aktiv</MnStatusBadge>
                  ) : (
                    <MnStatusBadge>Inaktiv</MnStatusBadge>
                  )}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </section>
    </>
  )
}
