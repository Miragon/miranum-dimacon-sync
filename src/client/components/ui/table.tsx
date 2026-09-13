import { cn } from "#/lib/utils"
import { type ComponentProps } from "react"

function Table({ className, ...props }: ComponentProps<"table">) {
  return (
    // `overflow-auto` macht breite Tabellen am Handy wischbar — ohne Hinweis
    // merkt das aber niemand. Die Kante rechts zeigt, dass es weitergeht.
    <div className="w-full overflow-auto [scrollbar-width:thin] max-md:-mr-6 max-md:pr-6">
      <table
        data-slot="table"
        className={cn("border-ink w-full border-collapse border-y-[1.5px] text-sm", className)}
        {...props}
      />
    </div>
  )
}

function TableHeader({ className, ...props }: ComponentProps<"thead">) {
  return <thead data-slot="table-header" className={cn("", className)} {...props} />
}

function TableBody({ className, ...props }: ComponentProps<"tbody">) {
  return <tbody data-slot="table-body" className={cn("", className)} {...props} />
}

function TableRow({ className, ...props }: ComponentProps<"tr">) {
  return (
    <tr
      data-slot="table-row"
      className={cn("border-rule-soft border-b last:border-b-0", className)}
      {...props}
    />
  )
}

function TableHead({ className, ...props }: ComponentProps<"th">) {
  return (
    <th
      data-slot="table-head"
      className={cn(
        "border-rule text-ink-2 border-b px-3 py-3 text-left font-mono text-[0.7rem] font-medium tracking-[0.18em] uppercase",
        className,
      )}
      {...props}
    />
  )
}

function TableCell({ className, ...props }: ComponentProps<"td">) {
  return (
    <td
      data-slot="table-cell"
      className={cn("text-ink px-3 py-3 align-middle", className)}
      {...props}
    />
  )
}

export { Table, TableHeader, TableBody, TableRow, TableHead, TableCell }
