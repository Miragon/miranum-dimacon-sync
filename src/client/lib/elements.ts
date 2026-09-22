/**
 * Miranum element registry — the "periodic table" data behind ElementBox grids.
 * Enthält die in diesem Projekt angebundenen Systeme; Status kommt zur
 * Laufzeit aus `GET /api/systems` (gematcht über `systemId`).
 */

export type ElementGroup = "finance" | "ops" | "time" | "tools" | "ai" | "ui" | "ws" | "go"

export interface MiranumElement {
  no: string
  symbol: string
  name: string
  /** 2-letter group code shown in top-right of the box */
  ig: string
  /** Color group (only finance/ops/time/tools/ai render with color) */
  group?: Extract<ElementGroup, "finance" | "ops" | "time" | "tools" | "ai">
  description?: string
  /** Server-seitige System-ID (`GET /api/systems`) */
  systemId?: string
}

export const MIRANUM_ELEMENTS: MiranumElement[] = [
  {
    no: "01",
    symbol: "Dm",
    name: "Dimacon",
    ig: "BS",
    group: "ops",
    description: "Baustellenmanagement",
    systemId: "dimacon",
  },
  {
    no: "02",
    symbol: "Ck",
    name: "ClockIn",
    ig: "ZE",
    group: "time",
    description: "Zeiterfassung",
    systemId: "clockin",
  },
  {
    no: "03",
    symbol: "Lx",
    name: "Lexware Office",
    ig: "BU",
    group: "finance",
    description: "Buchhaltung & Rechnungen",
    systemId: "lexoffice",
  },
  {
    no: "04",
    symbol: "Sd",
    name: "sevDesk",
    ig: "BU",
    group: "finance",
    description: "Buchhaltung & Rechnungen",
    systemId: "sevdesk",
  },
]

export function findElementBySystem(systemId: string): MiranumElement | undefined {
  return MIRANUM_ELEMENTS.find((e) => e.systemId === systemId)
}
