import { AsyncLocalStorage } from "node:async_hooks"

/**
 * Lauf-Metrik je Integrations-Lauf: Dauer und Request-Zähler pro Phase und
 * Zielsystem. Der Scope hängt an AsyncLocalStorage (node:async_hooks, Core —
 * keine neue Abhängigkeit), damit weder die Integrationen noch die
 * Client-Instrumentierung ein Metrik-Objekt durchreichen müssen.
 *
 * Alle Zähl-Funktionen sind AUSSERHALB eines Scopes reine No-ops — Tests und
 * Wegwerf-Clients (connection-test.ts) laufen dadurch unverändert weiter.
 */

export type MetricSystem = "dimacon" | "clockin" | "lexoffice"

export const METRIC_SYSTEMS: readonly MetricSystem[] = ["dimacon", "clockin", "lexoffice"]

export interface RequestCounts {
  dimacon: number
  clockin: number
  lexoffice: number
}

export interface PhaseMetrics {
  phase: string
  durationMs: number
  requests: RequestCounts
  retries: number
  rateLimited: number
  waitedMs: number
}

export interface RunMetricsSnapshot {
  totalMs: number
  requests: RequestCounts
  retries: number
  rateLimited: number
  waitedMs: number
  /**
   * Reihenfolge = Startreihenfolge der Phasen. ACHTUNG: parallel gestartete
   * Phasen überlappen bewusst — die Summe der Phasen-Dauern ist deshalb
   * größer als `totalMs` und keine Zerlegung der Gesamtdauer.
   */
  phases: PhaseMetrics[]
}

interface Counters {
  requests: RequestCounts
  retries: number
  rateLimited: number
  waitedMs: number
}

interface PhaseNode extends Counters {
  phase: string
  startedAt: number
  /**
   * Endzeitpunkt statt Dauer: `undefined` heißt eindeutig „läuft noch".
   * Eine 0 als Dauer wäre von „noch nicht gemessen" nicht unterscheidbar —
   * jede Phase, die innerhalb derselben Millisekunde fertig wird (leere
   * Task-Liste, Mapping ohne Discovery-Calls), meldete sonst die Zeit bis
   * zum Snapshot statt ihrer eigenen.
   */
  endedAt?: number
}

interface RunScope extends Counters {
  startedAt: number
  phases: PhaseNode[]
  now: () => number
}

/** Store = laufweiter Scope + die INNERSTE gerade laufende Phase. */
interface Store {
  run: RunScope
  phase?: PhaseNode
}

const storage = new AsyncLocalStorage<Store>()

function emptyCounters(): Counters {
  return {
    requests: { dimacon: 0, clockin: 0, lexoffice: 0 },
    retries: 0,
    rateLimited: 0,
    waitedMs: 0,
  }
}

/**
 * Öffnet den Metrik-Scope für einen Lauf. `onSnapshot` wird GENAU EINMAL
 * aufgerufen — auch wenn `fn` wirft (finally), damit der Fehlerpfad in
 * registry.ts dieselben Zahlen loggen kann wie der Erfolgspfad.
 */
export async function withRunMetrics<T>(
  fn: () => Promise<T>,
  onSnapshot?: (snapshot: RunMetricsSnapshot) => void,
  /** Injizierbare Uhr — nur für Tests, Produktion nutzt `Date.now`. */
  now: () => number = Date.now,
): Promise<T> {
  const run: RunScope = { ...emptyCounters(), startedAt: now(), phases: [], now }
  try {
    return await storage.run({ run }, fn)
  } finally {
    onSnapshot?.(buildSnapshot(run))
  }
}

/**
 * Misst eine Phase. Requests innerhalb werden der INNERSTEN Phase
 * zugeordnet und zusätzlich immer den Lauf-Totalen. Ohne offenen
 * Lauf-Scope wird `fn` einfach durchgereicht (No-op).
 */
export async function withPhase<T>(phase: string, fn: () => Promise<T>): Promise<T> {
  const store = storage.getStore()
  if (!store) return fn()

  const node: PhaseNode = {
    ...emptyCounters(),
    phase,
    startedAt: store.run.now(),
  }
  store.run.phases.push(node)
  try {
    return await storage.run({ run: store.run, phase: node }, fn)
  } finally {
    node.endedAt = store.run.now()
  }
}

/** Ein abgesetzter HTTP-Request gegen `system`. No-op ohne Scope. */
export function countRequest(system: MetricSystem): void {
  const store = storage.getStore()
  if (!store) return
  store.run.requests[system] += 1
  if (store.phase) store.phase.requests[system] += 1
}

/** Ein Wiederholungsversuch samt Wartezeit. No-op ohne Scope. */
export function countRetry(opts: { waitedMs: number; rateLimited: boolean }): void {
  const store = storage.getStore()
  if (!store) return
  for (const target of [store.run, store.phase]) {
    if (!target) continue
    target.retries += 1
    target.waitedMs += opts.waitedMs
    if (opts.rateLimited) target.rateLimited += 1
  }
}

/** Momentaufnahme des laufenden Scopes; `undefined` außerhalb eines Laufs. */
export function snapshotMetrics(): RunMetricsSnapshot | undefined {
  const store = storage.getStore()
  return store ? buildSnapshot(store.run) : undefined
}

/** Nur für Tests/Instrumentierung: läuft gerade ein Metrik-Scope? */
export function hasRunMetricsScope(): boolean {
  return storage.getStore() !== undefined
}

function buildSnapshot(run: RunScope): RunMetricsSnapshot {
  const at = run.now()
  return {
    totalMs: at - run.startedAt,
    requests: { ...run.requests },
    retries: run.retries,
    rateLimited: run.rateLimited,
    waitedMs: run.waitedMs,
    phases: run.phases.map((p) => ({
      phase: p.phase,
      // Noch laufende Phasen (früher Snapshot) melden die bisherige Dauer.
      durationMs: (p.endedAt ?? at) - p.startedAt,
      requests: { ...p.requests },
      retries: p.retries,
      rateLimited: p.rateLimited,
      waitedMs: p.waitedMs,
    })),
  }
}
