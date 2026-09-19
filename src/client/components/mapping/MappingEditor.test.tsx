// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react"
import { afterEach, describe, expect, it } from "vitest"
import { MappingEditor } from "./MappingEditor"
import type { MappingEntityBlock } from "./MappingEditor"

afterEach(cleanup)

const noop = () => {
  /* Speichern ist hier nicht Gegenstand */
}

function reverseBlock(overrides: Partial<MappingEntityBlock> = {}): MappingEntityBlock {
  return {
    entity: "dimaconCustomer",
    isDefault: false,
    rules: [],
    locked: [{ sourceLabel: "Kundennummer", targetField: "customerNumber", note: "match-key" }],
    requiredTargets: [],
    writeSemantics: "fillIfNonEmpty",
    sources: {
      standard: [{ field: "vatRegistrationId", label: "USt-IdNr." }],
      attributes: [],
    },
    targets: {
      standard: [{ field: "street", label: "Straße", dataType: "text" }],
      custom: [],
      attributes: [
        {
          id: "a-req",
          label: "Kostenstelle",
          type: "STRING",
          isActive: true,
          isRequired: true,
        },
        {
          id: "a-sel",
          label: "Kategorie",
          type: "SELECT",
          isActive: true,
          isRequired: false,
          problem: "Dimacon-Attribut „Kategorie“ (SELECT) kann nicht befüllt werden",
        },
        {
          id: "a-off",
          label: "Altfeld",
          type: "STRING",
          isActive: false,
          isRequired: false,
          problem: "Dimacon-Attribut „Altfeld“ ist deaktiviert",
        },
      ],
    },
    warnings: [],
    discoveryErrors: [],
    ...overrides,
  }
}

function renderEditor(block: MappingEntityBlock) {
  render(<MappingEditor integrationId="dimacon-lexoffice" block={block} onSaved={noop} />)
}

describe("MappingEditor — Übernahme Lexware → Dimacon", () => {
  it("benennt Lexware als Quelle und Dimacon als Ziel", () => {
    renderEditor(reverseBlock())
    expect(screen.getByText("Lexware-Office-Quellfelder")).toBeTruthy()
    expect(screen.getByText("Dimacon-Zielfelder")).toBeTruthy()
  })

  it("zeigt Pflicht-Attribute markiert und nicht befüllbare ausgegraut", () => {
    renderEditor(reverseBlock())
    // Das Pflicht-Attribut trägt den Stern
    expect(screen.getByText("Kostenstelle").textContent).toContain("*")
    // Auswahlfeld sichtbar, aber kein Drop-Ziel
    expect(screen.getByText("Kategorie").closest("[title]")?.getAttribute("title")).toContain(
      "SELECT",
    )
    expect(screen.getByText("nicht befüllbar")).toBeTruthy()
    // Deaktiviertes Attribut ohne Regel bleibt unsichtbar
    expect(screen.queryByText("Altfeld")).toBeNull()
  })

  it("zeigt ein deaktiviertes Attribut, solange eine Regel darauf zeigt", () => {
    renderEditor(
      reverseBlock({
        rules: [
          {
            source: { kind: "standard", field: "vatRegistrationId" },
            target: { kind: "attribute", attributeId: "a-off" },
          },
        ],
      }),
    )
    expect(screen.getByText("Altfeld")).toBeTruthy()
    // … und die Regel lässt sich entfernen
    expect(screen.getByLabelText("Zuordnung für Altfeld entfernen")).toBeTruthy()
  })
})
