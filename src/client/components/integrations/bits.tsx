export function ResultSectionHead({ title }: { title: string }) {
  return (
    <h2 className="text-ink mb-4 font-mono text-[0.75rem] tracking-[0.18em] uppercase">{title}</h2>
  )
}

export function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="border-rule border-r border-b p-4 last:border-r-0 md:border-b-0">
      <dt className="text-ink-3 font-mono text-[0.65rem] tracking-[0.18em] uppercase">{label}</dt>
      <dd className="text-ink mt-1 font-mono text-base">{value}</dd>
    </div>
  )
}
