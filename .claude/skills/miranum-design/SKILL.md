---
name: miranum-design
description: >
  Miranum "Swiss Lab" Design-Disziplin und Komponenten-Referenz. Verwende diesen Skill
  immer wenn UI gebaut, geändert oder reviewt wird — neue React-Komponenten, Page-Layouts,
  Styling-Anpassungen, Design-Reviews. Auch bei Fragen wie "wie sieht das aus", "passt
  das zum Design", "welche Komponente nehmen", "wie style ich X". Quelle der Wahrheit für
  Tokens, Komponenten, Patterns. Nutzt Tailwind v4 + shadcn (auf Miranum gemappt).
---

# Miranum Design System — Reference

Visuelles Vorbild liegt unter `.context/attachments/style-guide.html` (im Browser
öffnen für Live-Demo aller Tokens und Komponenten). Tokens werden in
`src/client/styles.css` definiert.

---

## Kern-Disziplin

**Do**

- **Square corners überall.** `--radius: 0` ist gesetzt, jede Tailwind-Radius-Stufe
  ist auf `0` zwangs-gemappt. Wenn etwas rund aussieht, ist es ein Bug.
- **1px-Borders.** Keine Schatten, keine Glasmorphism, keine Gradients.
- **Akzent-Rot** (`bg-mn-accent` / `text-mn-accent` / `--mn-accent`) **nur einmal
  pro Screen** — Kicker, Tagline oder ein einziger Primär-CTA. Nicht für
  Standard-Buttons.
- **Mono-Schrift** (`font-mono`, `mn-mono`) für Labels, Daten, Metadaten, Kicker.
  **Inter** für alles Lesbare.
- **Group-Farben** (`grp-finance`, `grp-ops`, `grp-time`, `grp-tools`, `grp-ai`)
  **ausschließlich** auf `<ElementBox>` und `<MnFeature accent="…">`. Niemals
  für Buttons, Links, Status, sonstige UI-Aktionen.
- Generös Whitespace. „Zu wenig" ist meistens richtig.

**Don't**

- Keine zweite Display-Schrift einführen.
- Keine `rounded-*`-Utilities auf Komponenten kleben — das negiert die Design-Sprache.
- Keine Drop-Shadows / `shadow-*`.
- Keine Group-Farben für UI-Aktionen.
- Keine Emoji-Icons in Produktiv-UI (für Demos OK). `lucide-react` ist installiert.
- Keine ElementBox-Rotation/Schräglage — sie ist ein technisches Token, kein
  dekoratives Schmuckelement.
- Keine Dark-Mode-Variante hinzufügen ohne explizite Anforderung — Style-Guide ist
  bewusst light-only.
- **ElementBox + Bereich-Kicker nicht als Page-Header-Schmuck** auf jeder
  Subpage. Sie passen auf Landing/Dashboard, nicht über jedem Form oder jeder
  Tabelle.

---

## Tokens (`src/client/styles.css`)

| Token        | Wert        | Tailwind-Utility       | Verwendung                    |
| ------------ | ----------- | ---------------------- | ----------------------------- |
| `--mn-paper` | `#ffffff`   | `bg-paper`             | Default-Hintergrund           |
| `--mn-paper-2` | `#f6f6f4` | `bg-paper-2`           | Subtle Container              |
| `--mn-paper-3` | `#efeeea` | `bg-paper-3`           | Hover / Muted                 |
| `--mn-ink`   | `#0a0a0a`   | `text-ink`             | Primary-Text + Primary-Button |
| `--mn-ink-2` | `#6b6b6b`   | `text-ink-2`           | Body-Text Secondary           |
| `--mn-ink-3` | `#9a9a96`   | `text-ink-3`           | Mono-Labels                   |
| `--mn-rule`  | `#d8d8d4`   | `border-rule`          | 1px-Borders                   |
| `--mn-accent`| `#e6332a`   | `bg-mn-accent` / `text-mn-accent` | Akzent — sparsam!  |
| `--grp-*`    | div Farben  | `bg-grp-finance` etc.  | **Nur ElementBox / MnFeature** |

**Schriften:**

- Inter Variable (`font-sans`) — Default
- IBM Plex Mono (`font-mono`) — Labels, Daten, Kicker

**Type-Scale-Klassen** (in `styles.css`): `text-h-display` (4rem), `text-h-1` (3rem),
`text-h-2`, `text-h-3`, `text-h-4`, `text-body-lg`, `text-body`, `text-body-sm`.
Mono-Helper: `mn-mono` (Letter-spacing + uppercase + `--mn-ink-3`),
`mn-mono-accent` (rot).

---

## shadcn-Primitives — `src/client/components/ui/`

Bereits installiert und auf Miranum ge-themed:

- `button.tsx` — Variants `default | secondary | outline | ghost | accent | link`,
  Sizes `default | sm | lg | icon`. Square corners durch `--radius: 0`.
- `input.tsx` — `border-ink`, square, Focus-Ring rot.
- `label.tsx` — Mono, uppercase, `text-ink-2`, tracking `0.18em`.
- `card.tsx` — Border, square, no shadow.
- `table.tsx` — 1px-Border, mono Header.

**Beim Hinzufügen via `npx shadcn add <name>`** alle Rundungen, Shadows und
Akzent-Farben prüfen und an Miranum anpassen, bevor verwendet wird.

---

## Miranum-Primitives — `src/client/components/miranum/`

Die einzigartigen Patterns aus dem Style-Guide. Alle exportieren über
`miranum/index.ts`.

### `<ElementBox no symbol name ig group? size?>`

Periodensystem-Tile. Props: `no` (Ordnungszahl, z.B. "01"), `symbol` (1-2 Buchstaben,
z.B. "Mn"), `name`, `ig` (Industriegruppe oben rechts, z.B. "WS"),
`group?` (Element-Gruppen-Farbe), `size?` (`sm | hero`, default normal).

**Verwendung:** Landing/Dashboard-Hero, Module-Grids, niemals als beliebige
Page-Header-Decoration.

### `<SectionHead kicker title description?>`

Akzent-Bullet + Mono-Kicker + H2 + optionale Description. Für Sektions-Trenner
innerhalb einer Page. Nicht doppelt verwenden, wenn nur ein Form/Block folgt.

### `<MnTagline>`

Roter 1px-Border-Pill mit Mono-Text. **Pro Page maximal einmal** — die Marke
„DAS FEHLENDE ELEMENT FÜRS HANDWERK." steht bereits als statische Watermark in
`PageChrome` rechts unten. Auf der Home-Tagline besser einen page-spezifischen
Slogan verwenden.

### `<MnFeature title accent? children>`

3-Spalten-Karte mit farbigem 4px-Left-Border und Group-Akzent. Akzepts
`accent: "default" | "finance" | "ops" | "time" | "tools" | "ai"`.

### `<MnAlert label children>`

Border-Box mit `border-l-mn-accent` 3px + Mono-Label oben. Für Inline-Hinweise,
Fehler, Wichtig-Markierungen.

### `<MnStep>` / `<MnStepList>`

Nummerierte Schritt-Reihen mit Mono-Index, Border-Trennern.

### `<MnStatusBadge variant?>`

Mono-Badge. Variants: `default` (border, ink), `ok` (filled ink), `warn` (red border).

---

## Page-Header-Pattern

**Landing/Dashboard** (z.B. `/`): MnTagline + großer Display-Title + Description +
ElementBox als Hero rechts. Akzent kommt durch die MnTagline + Title-Underline.

**Subpage** (z.B. `/sync`, `/modules`): Schlichter Header — Mono-Tagline (uppercase
ink-3) ODER nichts + H1 + Description. **Kein ElementBox-Schmuck**, kein
„Bereich · NN / Sx"-Kicker. Direkt das Inhalts-Form/-Grid darunter, kein
SectionHead wenn nur ein Block folgt.

```tsx
// Subpage-Header (clean)
<header className="mb-12">
  <span className="mn-mono">/sync · operations</span>
  <h1 className="text-h-1 text-ink mt-4">Sync</h1>
  <p className="text-body mt-3 max-w-[540px]">…</p>
</header>
```

```tsx
// Landing-Header (mit Hero-ElementBox)
<header className="border-rule mb-20 grid items-end gap-12 border-b pb-12 md:grid-cols-[1fr_auto]">
  <div>
    <MnTagline>page-spezifischer Slogan</MnTagline>
    <h1 className="text-h-display text-ink mt-6">…</h1>
    <p className="text-body-lg mt-6 max-w-[580px]">…</p>
  </div>
  <ElementBox no="01" symbol="Mn" name="Miranum" ig="WS" size="hero" />
</header>
```

---

## Element-Registry

`#/lib/elements.ts` exportiert `MIRANUM_ELEMENTS` als Quelle für Module-Listen.
Neue Module dort hinzufügen, dann via `MIRANUM_ELEMENTS.filter(...)` rendern.

---

## Quality Gates

Pre-Commit erzwingt: `pnpm typecheck && pnpm lint && pnpm format:check && pnpm build`.
Bei Design-Änderungen zusätzlich im Browser an Desktop (1280) und Mobile (375)
verifizieren — Pre-Commit erkennt keine Layout-Regressionen.
