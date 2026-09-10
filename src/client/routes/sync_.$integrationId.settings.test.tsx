// @vitest-environment jsdom
import { RouterProvider, createMemoryHistory, createRouter } from "@tanstack/react-router"
import { cleanup, render, screen, waitFor } from "@testing-library/react"
import { afterEach, describe, expect, it, vi } from "vitest"
import { routeTree } from "#/routeTree.gen"

// Devtools-Panels sind für diesen Test irrelevant und ziehen nur Gewicht.
vi.mock("@tanstack/react-devtools", () => ({ TanStackDevtools: () => null }))
vi.mock("@tanstack/react-router-devtools", () => ({ TanStackRouterDevtoolsPanel: () => null }))

const INTEGRATION = {
  id: "dimacon-clockin",
  name: "Dimacon → Clockin",
  description: "Tagesplanung",
  systems: ["dimacon", "clockin"],
  configured: true,
  missingCredentials: [],
  running: false,
  cronActive: false,
  nextRun: null,
  mappable: true,
  runDefaults: { dryRun: true, steps: { employees: false } },
}

const SCHEDULE = {
  id: "dimacon-clockin",
  name: "Dimacon → Clockin",
  enabled: false,
  timezone: "Europe/Berlin",
  runDefaults: { dryRun: true, steps: { employees: false } },
  active: false,
  nextRun: null,
  nextRuns: [],
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  })
}

/** Stubt die drei Requests der Seite; `scheduleResponse` ist der Prüfpunkt. */
function stubApi(scheduleResponse: () => Response) {
  vi.stubGlobal(
    "fetch",
    vi.fn((input: string | URL | Request) => {
      const url = String(input instanceof Request ? input.url : input)
      if (url.includes("/api/settings/integrations")) return Promise.resolve(scheduleResponse())
      if (url.includes("/api/integrations")) return Promise.resolve(json([INTEGRATION]))
      if (url.includes("/api/credentials")) return Promise.resolve(json([]))
      return Promise.resolve(json({ error: "unexpected" }, 500))
    }),
  )
}

async function renderScopeTab() {
  // jsdom kennt kein scrollTo — der Router ruft es beim Mount auf.
  window.scrollTo = () => undefined
  const router = createRouter({
    routeTree,
    history: createMemoryHistory({
      initialEntries: ["/sync/dimacon-clockin/settings?tab=umfang"],
    }),
  })
  // Der Router ist hier nur Transportmittel für Params/Search der Seite.
  render(<RouterProvider router={router as never} />)
  await waitFor(() => expect(screen.getByText("Einstellungen")).toBeTruthy())
}

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

/**
 * Der Umfang-Tab darf NIE einen erfundenen Ausgangszustand zeigen: schlägt
 * `/api/settings/integrations` fehl (5xx mit JSON-Body — genau die Gestalt des
 * sanitisierten `app.onError`), fehlt der gespeicherte Umfang. Ohne Wache
 * stünden dort die Schema-Defaults („alles an, live") und ein Klick auf
 * Speichern würde einen bewusst reduzierten Umfang überschreiben.
 */
describe("Umfang-Tab der Integrations-Einstellungen", () => {
  it("shows an error instead of the editor when the schedule load failed", async () => {
    stubApi(() => json({ error: "internal error" }, 500))
    await renderScopeTab()

    await waitFor(() => expect(screen.getByText(/umfang konnte nicht geladen werden/)).toBeTruthy())
    expect(screen.queryByRole("button", { name: /Speichern/ })).toBeNull()
    expect(screen.queryByText(/Gespeicherter Umfang/)).toBeNull()
    // Insbesondere kein „voll · live" o. ä. als erfundene Basislinie.
    expect(screen.queryByText(/live/)).toBeNull()
  })

  it("renders the stored scope when the schedule load succeeded", async () => {
    stubApi(() => json([SCHEDULE]))
    await renderScopeTab()

    await waitFor(() => expect(screen.getByText(/Gespeicherter Umfang/)).toBeTruthy())
    expect(screen.getByText("4 von 6 Schritten · dry-run")).toBeTruthy()
    expect(screen.getByRole("button", { name: /Speichern/ })).toBeTruthy()
  })
})
