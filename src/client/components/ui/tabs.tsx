import { Tabs as TabsPrimitive } from "@base-ui/react/tabs"
import { cn } from "#/lib/utils"

/**
 * Tabs in Miranum-Optik: 1px-Border-Kacheln, eckig, kein Schatten, Mono-Label.
 * Der aktive Tab wird über `border-ink` + `text-ink` markiert (nicht über eine
 * Füllfläche) — vier schwarz gefüllte Kacheln direkt unter einer text-h-1-
 * Überschrift wären ein zweiter Schwerpunkt neben dem Titel.
 *
 * Bewusst ohne eigenen Panel-State: die Einstellungsseite hält den aktiven Tab
 * in der URL (`?tab=…`), damit Reload und Deep-Link ihn behalten. `value` +
 * `onValueChange` werden von außen gesteuert.
 */
function Tabs({ className, ...props }: TabsPrimitive.Root.Props) {
  return (
    <TabsPrimitive.Root data-slot="tabs" className={cn("flex flex-col", className)} {...props} />
  )
}

function TabsList({ className, ...props }: TabsPrimitive.List.Props) {
  return (
    <TabsPrimitive.List
      data-slot="tabs-list"
      className={cn("border-rule flex flex-wrap gap-3 border-b pb-4", className)}
      {...props}
    />
  )
}

function TabsTrigger({ className, ...props }: TabsPrimitive.Tab.Props) {
  return (
    <TabsPrimitive.Tab
      data-slot="tabs-trigger"
      className={cn(
        "border-rule text-ink-2 hover:border-ink hover:text-ink border px-4 py-2 font-mono text-[0.75rem] tracking-[0.14em] uppercase transition-colors",
        "focus-visible:outline-mn-accent focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2",
        "data-selected:border-ink data-selected:text-ink",
        className,
      )}
      {...props}
    />
  )
}

function TabsPanel({ className, ...props }: TabsPrimitive.Panel.Props) {
  return (
    <TabsPrimitive.Panel
      data-slot="tabs-panel"
      className={cn("mt-10 outline-none", className)}
      {...props}
    />
  )
}

export { Tabs, TabsList, TabsPanel, TabsTrigger }
