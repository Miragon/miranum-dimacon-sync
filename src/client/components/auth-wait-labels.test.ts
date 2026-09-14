// @vitest-environment jsdom
import { readFileSync } from "node:fs"
import { describe, expect, it } from "vitest"

import { WAIT_LABELS } from "./AuthGate"

/**
 * REGRESSION (Kommentar-Drift, live aufgetreten): Der Vorraum des AuthGate hat
 * ZWEI Warteanzeigen, die zwei verschiedene Zustände benennen — `isLoading`
 * (authkit startet) gegen Auto-signIn (es wird wirklich umgeleitet). Als der
 * Startzustand seinen eigenen Text bekam, blieben mehrere Kommentare bei der
 * alten, abgekürzten Zitierweise „weiterleiten …" stehen, obwohl sie exakt den
 * Startzustand beschreiben. Wer daraufhin den Feldbericht „die Seite steht in
 * der weiterleiten-Anzeige" bekommt, sucht im falschen Zustand.
 *
 * Diese Kommentare sind hier Diagnose-Artefakte (CLAUDE.md widmet dem Auth-Pfad
 * einen eigenen Abschnitt), also werden sie geprüft: Jede Zitierung einer
 * Warteanzeige muss WÖRTLICH einer der gerenderten Anzeigen entsprechen.
 * Abkürzen ist das, was die Drift unsichtbar gemacht hat — genau deshalb
 * scheitert „weiterleiten …" an dieser Regel.
 *
 * Dass die Konstanten selbst die gerenderten Texte sind, sichern die
 * Verhaltens-Tests: `AuthGate.startup.test.tsx` und `AuthGate.callback.test.tsx`
 * pinnen `starting` im Ladefenster, `AuthGate.test.tsx` `redirecting` beim
 * Auto-signIn.
 */
const SOURCES = [
  "src/client/components/AuthGate.tsx",
  "src/client/lib/auth-callback.ts",
  "src/client/components/AuthGate.test.tsx",
  "src/client/components/AuthGate.callback.test.tsx",
  "src/client/components/AuthGate.startup.test.tsx",
  "CLAUDE.md",
]

/**
 * Eine Zitierung: deutsches Anführungszeichen auf, Text, Anführungszeichen zu.
 * Geprüft werden nur Zitate, die auf „…" enden — so werden diese Mono-Anzeigen
 * geschrieben, und andere Zitate in denselben Dateien (Overlay-Titel,
 * Fehler-Codes, Prosa) bleiben unberührt.
 */
const CITATION = /[„‚]([^„‚\n]*?)["'“”‘’]/g

function waitLabelCitations(source: string): string[] {
  return [...source.matchAll(CITATION)]
    .map((match) => match[1])
    .filter((text) => text.trimEnd().endsWith("…"))
}

describe("Zitate der Warteanzeigen", () => {
  const labels: string[] = Object.values(WAIT_LABELS)

  it("zitiert nur Texte, die es wirklich gibt", () => {
    const citations = SOURCES.flatMap((file) =>
      waitLabelCitations(readFileSync(file, "utf8")).map((text) => `${file}: ${text}`),
    )

    // Ohne diese Bremse würde ein kaputtes Muster (oder eine umbenannte Datei)
    // stillschweigend „nichts gefunden, also alles gut" melden.
    expect(citations.length).toBeGreaterThan(0)
    const fremde = citations.filter(
      (citation) => !labels.some((label) => citation.endsWith(`: ${label}`)),
    )
    expect(fremde).toEqual([])
  })

  it("hält die beiden Anzeigen auseinander", () => {
    // Die eine darf nie ein Präfix der anderen werden: genau das machte die
    // abgekürzte Zitierweise plausibel und die Verwechslung unauffällig.
    expect(WAIT_LABELS.starting).not.toBe(WAIT_LABELS.redirecting)
    expect(WAIT_LABELS.redirecting.startsWith(WAIT_LABELS.starting)).toBe(false)
    expect(WAIT_LABELS.starting.startsWith(WAIT_LABELS.redirecting)).toBe(false)
  })
})
