import { Link } from "@tanstack/react-router"
import { AUTH_ENABLED } from "../lib/auth-flag.js"
import { UserMenu } from "./UserMenu.js"

export interface PageChromeProps {
  /** Top-left mono label, e.g. "MIRANUM · MN · 01 / WS · SYNC" */
  label?: string
  /** Bottom-right mono tagline */
  foot?: string
}

// Deutsch wie die gesamte Oberfläche, und mit denselben Wörtern wie die
// Zielseiten: die Nav hieß „Sync“, die Kachel „Integrationen“ und die H1
// ebenfalls „Integrationen“ — drei Namen für ein Ziel.
const NAV = [
  { to: "/", label: "Übersicht" },
  { to: "/sync", label: "Integrationen" },
  { to: "/modules", label: "Systeme" },
  { to: "/settings", label: "Einstellungen" },
] as const

export function PageChrome({
  label = "MIRANUM · MN · 01 / WS · SYNC",
  foot = "Das fehlende Element fürs Handwerk.",
}: PageChromeProps) {
  return (
    <>
      <Link
        to="/"
        className="text-ink-3 hover:text-ink fixed top-6 left-12 z-50 font-mono text-[10px] tracking-[0.22em] uppercase transition-colors max-md:hidden"
      >
        {label}
      </Link>
      <div className="text-ink-3 pointer-events-none fixed right-12 bottom-6 z-50 font-mono text-[10px] tracking-[0.18em] max-md:hidden">
        {foot}
      </div>
      <nav className="fixed top-5 right-12 z-50 flex flex-wrap items-center justify-end gap-x-6 gap-y-2 max-md:static max-md:px-6 max-md:pt-6">
        {NAV.map((item) => (
          <Link
            key={item.to}
            to={item.to}
            className="hover:text-ink font-mono text-[11px] tracking-[0.18em] uppercase transition-colors"
            activeProps={{ className: "text-ink" }}
            inactiveProps={{ className: "text-ink-3" }}
            activeOptions={{ exact: item.to === "/" }}
          >
            {item.label}
          </Link>
        ))}
        {AUTH_ENABLED ? <UserMenu /> : null}
      </nav>
    </>
  )
}
