import { Link } from "@tanstack/react-router"

export interface PageChromeProps {
  /** Top-left mono label, e.g. "MIRANUM · MN · 01 / WS · TEMPLATE" */
  label?: string
  /** Bottom-right mono tagline */
  foot?: string
}

const NAV = [
  { to: "/", label: "Home" },
  { to: "/modules", label: "Modules" },
] as const

export function PageChrome({
  label = "MIRANUM · MN · 01 / WS · TEMPLATE",
  foot = "Das fehlende Element fürs Handwerk.",
}: PageChromeProps) {
  return (
    <>
      <div className="text-ink-3 pointer-events-none fixed top-6 left-12 z-50 font-mono text-[10px] tracking-[0.22em] uppercase max-md:hidden">
        {label}
      </div>
      <div className="text-ink-3 pointer-events-none fixed right-12 bottom-6 z-50 font-mono text-[10px] tracking-[0.18em] max-md:hidden">
        {foot}
      </div>
      <nav className="fixed top-5 right-12 z-50 flex items-center gap-6 max-md:static max-md:justify-end max-md:pt-6 max-md:pr-6">
        {NAV.map((item) => (
          <Link
            key={item.to}
            to={item.to}
            className="text-ink-3 hover:text-ink font-mono text-[11px] tracking-[0.18em] uppercase transition-colors"
            activeProps={{ className: "text-ink" }}
            activeOptions={{ exact: item.to === "/" }}
          >
            {item.label}
          </Link>
        ))}
      </nav>
    </>
  )
}
