import { describe, expect, it } from "vitest"
import {
  countRequest,
  countRetry,
  snapshotMetrics,
  withPhase,
  withRunMetrics,
  type RunMetricsSnapshot,
} from "./metrics.js"

async function tick(): Promise<void> {
  await new Promise((r) => setTimeout(r, 0))
}

/** Injizierbare Uhr für exakte Dauer-Assertions (Produktion: Date.now). */
function fakeClock(start = 1_700_000_000_000) {
  let t = start
  return {
    now: () => t,
    advance: (ms: number) => {
      t += ms
    },
  }
}

describe("metrics", () => {
  it("zählt Requests in der innersten Phase und in den Totals", async () => {
    let snapshot: RunMetricsSnapshot | undefined
    await withRunMetrics(
      async () => {
        countRequest("dimacon")
        await withPhase("enrich", async () => {
          countRequest("dimacon")
          countRequest("clockin")
          await withPhase("inner", async () => {
            countRequest("clockin")
          })
        })
      },
      (s) => (snapshot = s),
    )

    expect(snapshot?.requests).toEqual({ dimacon: 2, clockin: 2, lexoffice: 0 })
    const phases = snapshot!.phases
    expect(phases.map((p) => p.phase)).toEqual(["enrich", "inner"])
    // Der Request der inneren Phase zählt NICHT zusätzlich in "enrich".
    expect(phases[0]!.requests).toEqual({ dimacon: 1, clockin: 1, lexoffice: 0 })
    expect(phases[1]!.requests).toEqual({ dimacon: 0, clockin: 1, lexoffice: 0 })
  })

  it("vermischt parallel gestartete Phasen nicht", async () => {
    let snapshot: RunMetricsSnapshot | undefined
    await withRunMetrics(
      async () => {
        await Promise.all([
          withPhase("a", async () => {
            countRequest("dimacon")
            await tick()
            countRequest("dimacon")
          }),
          withPhase("b", async () => {
            await tick()
            countRequest("clockin")
          }),
        ])
      },
      (s) => (snapshot = s),
    )

    const byName = new Map(snapshot!.phases.map((p) => [p.phase, p]))
    expect(byName.get("a")!.requests.dimacon).toBe(2)
    expect(byName.get("a")!.requests.clockin).toBe(0)
    expect(byName.get("b")!.requests.clockin).toBe(1)
    expect(byName.get("b")!.requests.dimacon).toBe(0)
  })

  it("summiert Retries und Wartezeiten in Phase und Total", async () => {
    let snapshot: RunMetricsSnapshot | undefined
    await withRunMetrics(
      async () => {
        await withPhase("projects", async () => {
          countRetry({ waitedMs: 1_000, rateLimited: true })
          countRetry({ waitedMs: 500, rateLimited: false })
        })
      },
      (s) => (snapshot = s),
    )

    expect(snapshot?.retries).toBe(2)
    expect(snapshot?.rateLimited).toBe(1)
    expect(snapshot?.waitedMs).toBe(1_500)
    expect(snapshot?.phases[0]).toMatchObject({ retries: 2, rateLimited: 1, waitedMs: 1_500 })
  })

  it("ist außerhalb eines Scopes ein No-op", async () => {
    expect(() => countRequest("clockin")).not.toThrow()
    expect(() => countRetry({ waitedMs: 5, rateLimited: true })).not.toThrow()
    expect(snapshotMetrics()).toBeUndefined()
    expect(await withPhase("ohne-scope", async () => "ok")).toBe("ok")
  })

  it("liefert den Snapshot auch, wenn der Lauf wirft", async () => {
    let snapshot: RunMetricsSnapshot | undefined
    await expect(
      withRunMetrics(
        async () => {
          await withPhase("boom", async () => {
            countRequest("lexoffice")
            throw new Error("kaputt")
          })
        },
        (s) => (snapshot = s),
      ),
    ).rejects.toThrow("kaputt")

    expect(snapshot?.requests.lexoffice).toBe(1)
    expect(snapshot?.phases[0]?.phase).toBe("boom")
  })

  it("misst Phasendauern und die Gesamtdauer exakt", async () => {
    // Injizierte Uhr: nur so ist prüfbar, dass die Phase IHRE Dauer meldet
    // und nicht die Zeit bis zum Snapshot.
    const clock = fakeClock()
    let snapshot: RunMetricsSnapshot | undefined
    await withRunMetrics(
      async () => {
        await withPhase("kurz", async () => {
          clock.advance(12)
        })
        // Nach der Phase vergeht viel Zeit — ihre Dauer darf NICHT mitwachsen.
        clock.advance(5_000)
        await withPhase("lang", async () => {
          clock.advance(300)
        })
        clock.advance(700)
      },
      (s) => (snapshot = s),
      clock.now,
    )

    expect(snapshot!.phases.map((p) => [p.phase, p.durationMs])).toEqual([
      ["kurz", 12],
      ["lang", 300],
    ])
    expect(snapshot!.totalMs).toBe(6_012)
  })

  it("meldet eine sofort fertige Phase mit 0 statt mit der Laufdauer", async () => {
    // Eine 0 als "noch nicht gemessen" zu lesen ist der Klassiker: leere
    // Task-Liste bzw. Mapping ohne Discovery-Calls sind in <1 ms fertig.
    const clock = fakeClock()
    let snapshot: RunMetricsSnapshot | undefined
    await withRunMetrics(
      async () => {
        await withPhase("leer", async () => undefined)
        clock.advance(20_000)
      },
      (s) => (snapshot = s),
      clock.now,
    )

    expect(snapshot!.phases[0]!.durationMs).toBe(0)
    expect(snapshot!.totalMs).toBe(20_000)
  })

  it("meldet für eine noch laufende Phase die bisherige Dauer", async () => {
    const clock = fakeClock()
    await withRunMetrics(
      async () => {
        await withPhase("laeuft", async () => {
          clock.advance(40)
          expect(snapshotMetrics()?.phases).toEqual([
            expect.objectContaining({ phase: "laeuft", durationMs: 40 }),
          ])
        })
      },
      undefined,
      clock.now,
    )
  })
})
