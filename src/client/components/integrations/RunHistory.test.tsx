// @vitest-environment jsdom
import { cleanup, render, screen, waitFor, within } from "@testing-library/react"
import { afterEach, describe, expect, it, vi } from "vitest"
import type { RunHistoryEntry } from "#/lib/integrations"
import { RunHistory } from "./RunHistory"

/** Exakt die Zeile, die der Scheduler beim fail-closed-Skip schreibt. */
const SKIPPED: RunHistoryEntry = {
  id: "run-skipped",
  trigger: "cron",
  status: "skipped",
  // NOT-NULL-Platzhalter der Tabelle — kein Modus, kein Umfang.
  dryRun: false,
  input: {},
  error: "Der gespeicherte Umfang dieser Integration ist ungültig",
  startedAt: "2026-09-01T00:00:00.000Z",
  durationMs: 0,
}

/** Gegenprobe: ein Lauf, der wirklich lief und dabei scheiterte. */
const FAILED: RunHistoryEntry = {
  id: "run-failed",
  trigger: "manual",
  status: "error",
  dryRun: false,
  input: { dryRun: false, steps: { employees: true } },
  error: "Clockin nicht erreichbar",
  startedAt: "2026-09-01T01:00:00.000Z",
  durationMs: 4200,
}

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

/** `useApiFetch()` fällt ohne Provider auf das nackte `fetch` zurück. */
function stubRuns(rows: RunHistoryEntry[]): void {
  vi.stubGlobal(
    "fetch",
    vi.fn(() =>
      Promise.resolve(
        new Response(JSON.stringify(rows), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      ),
    ),
  )
}

function rowOf(text: string): HTMLElement {
  const cell = screen.getByText(text)
  const row = cell.closest("tr")
  if (!row) throw new Error(`keine Zeile zu „${text}"`)
  return row
}

describe("RunHistory", () => {
  /**
   * Der fail-closed übersprungene Cron-Lauf ist NIE gestartet: `dry_run` und
   * `input` sind NOT-NULL-Platzhalter. Zeigte die Historie sie an, behauptete
   * sie einen Live-Lauf mit vollem Umfang — das Gegenteil dessen, was
   * passiert ist, und der Mandant sucht den Fehler im Zielsystem.
   */
  it("zeigt für einen übersprungenen Lauf weder Modus noch Umfang", async () => {
    stubRuns([SKIPPED])
    render(<RunHistory integrationId="dimacon-clockin" />)

    await waitFor(() => expect(screen.getByText("übersprungen")).toBeTruthy())
    const row = rowOf("übersprungen")
    expect(within(row).queryByText("live")).toBeNull()
    expect(within(row).queryByText(/voll|Schritten/)).toBeNull()
    expect(within(row).getAllByText("—").length).toBeGreaterThanOrEqual(2)
    // Die Ursache bleibt sichtbar — nur der erfundene Umfang verschwindet.
    expect(within(row).getByText(/gespeicherte Umfang/)).toBeTruthy()
  })

  it("zeigt Modus und Umfang für einen wirklich gelaufenen Lauf", async () => {
    stubRuns([FAILED])
    render(<RunHistory integrationId="dimacon-clockin" />)

    await waitFor(() => expect(screen.getByText("fehler")).toBeTruthy())
    const row = rowOf("fehler")
    expect(within(row).getByText("live")).toBeTruthy()
    // Kein Vergleich auf den konkreten Zähltext — der gehört zu describeScope.
    expect(within(row).queryByText("—")).toBeNull()
  })
})
