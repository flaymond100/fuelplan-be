# Handover → Backend: rich plan_json rendering fields

**From:** frontend (`fuelplan`) · **Date:** 2026-05-27
**Contract:** [../fuelplan-shared/decisions/0004-plan-json-rich-fields.md](../fuelplan-shared/decisions/0004-plan-json-rich-fields.md)
**File to change:** [src/services/planGenerator.ts](src/services/planGenerator.ts) only.

## Why

The plan viewer was redesigned into a per-day tabbed layout: a timeline, meal
cards, a supplements grid, an in-race gel/fuel table, and severity-coloured
alerts. The current `plan_json` (decision 0003) can't drive the gel table,
supplements grid, macro chips, or coloured alerts because items aren't
categorised and `warnings` has no severity.

The FE is **already shipped** and degrades gracefully: with today's plans it
shows the timeline + meal cards + `warnings`-as-alerts. Your job is to emit four
new fields so the richer sections light up.

## Ground rules

- **Additive only. Do NOT bump `schemaVersion`** — it stays `1`. Per decision
  0003, adding optional fields is backwards-compatible.
- **No migration.** `plan_json` is a `jsonb` blob; new keys need no DB change.
- All four fields are **optional**. Old stored plans stay valid. The FE only
  renders the gel table / supplements grid when items actually carry `kind`.

## The four fields

### 1. `item.kind` (optional enum)

Values: `"meal" | "snack" | "fuel" | "supplement" | "hydration" | "action"`.

FE routing:
- `meal` / `snack` / `hydration` → meal cards + timeline
- `fuel` → **in-race gel/fuel table** (race phase) + timeline
- `supplement` → **supplements grid** + timeline
- `action` → **timeline only** — logistics steps with no nutrients
  (e.g. "Line up in the start corridor", "Bib pickup")

### 2. `item.detail` (optional string)

Compact one-liner for supplement cards (e.g. `"200mg — half-life covers the
full 4h race"`). FE falls back to `what` when absent.

### 3. `phase.macros` (optional array)

`{ "label": string, "tone"?: "default" | "green" | "amber" | "red" }[]`

The day's macro-strip chips, e.g.
`{ "label": "Carbs: 8–10 g/kg (~576–720g)", "tone": "default" }`,
`{ "label": "No deficit — full carb load", "tone": "red" }`.
Weight for g/kg is already in the profile prompt. FE falls back to chips built
from `phase.totals` when absent.

### 4. `plan.alerts` (optional array)

`{ "severity": "info" | "success" | "warning" | "danger", "title": string, "body": string }[]`

Replaces flat `warnings[]` for display. **Keep emitting `warnings` too** — the
FE maps each `warnings` string to a `warning`-severity alert when `alerts` is
absent, so don't remove it.

## Prompt changes (`buildPrompt`)

Add the optional keys to the item / phase / top-level schema in the output
template, and add these rules:

- Tag each item with `kind`:
  - pre-race supplements (creatine, beta-alanine, nitrates, bicarb, caffeine) →
    `"supplement"`, with a short `detail`.
  - in-race gels / drink-mix / chews / bars → `"fuel"`.
  - real meals → `"meal"`; small top-ups → `"snack"`; drinks → `"hydration"`.
  - logistics-only steps (line up, bib pickup, race brief) → `"action"` with
    all nutrient fields `0` and `carbsG: 0`.
- Emit `phase.macros` for each pre-race day: 2–4 chips with g/kg carb target,
  protein note, and a deficit/loading note. Use `tone` for emphasis
  (`red` for hard constraints, `amber` for cautions, `green` for positives).
- Emit top-level `alerts` for the important callouts (cut-off warnings, heat
  risk, caffeine caveats) with appropriate `severity`. Continue to populate
  `warnings` as before.

## Validation changes (`validate*`)

- `validateItem`: if `kind` present, assert it's one of the six enum strings,
  else drop it. If `detail` present and a non-empty string, keep it; else omit.
- `validatePhase`: if `macros` present, assert array; each entry needs a
  non-empty `label`; `tone` if present must be one of the four values (default
  to omit). Drop malformed entries rather than failing the whole plan.
- `validatePlanJson`: if `alerts` present, assert array; each needs a valid
  `severity`, non-empty `title`, non-empty `body`. Keep validating `warnings`
  exactly as today.
- Keep the rule that bad structure fails generation (HTTP 500,
  `PLAN_GENERATION_FAILED`) — but be lenient on these optional fields: malformed
  optional fields should be **dropped**, not fatal, so a minor model slip on a
  chip doesn't nuke an otherwise-valid plan.

## Example (abbreviated)

```jsonc
{
  "schemaVersion": 1,
  "summary": "...",
  "estimatedDurationMin": 255,
  "totals": { "carbsG": 280, "fluidsMl": 3500, "sodiumMg": 4200, "caffeineMg": 200, "kcal": 1400 },
  "phases": [
    {
      "id": "pre_race_d1",
      "label": "Friday — Travel + Carb Load",
      "startOffsetMin": -1440, "endOffsetMin": -600,
      "totals": { "carbsG": 600, "fluidsMl": 3000, "sodiumMg": 3000, "caffeineMg": 0, "kcal": 3200 },
      "macros": [
        { "label": "Carbs: 8–10 g/kg (~576–720g)", "tone": "default" },
        { "label": "No deficit — full carb load", "tone": "red" }
      ],
      "items": [
        { "offsetMin": -1380, "label": "Breakfast", "what": "80g granola, banana, jam, skyr, juice",
          "kind": "meal", "carbsG": 140, "fatG": 12, "proteinG": 18, "fluidsMl": 300,
          "sodiumMg": 200, "caffeineMg": 0, "kcal": 720, "notes": "Eat before leaving." }
      ]
    },
    {
      "id": "race",
      "label": "Race",
      "startOffsetMin": 0, "endOffsetMin": 255,
      "totals": { "carbsG": 225, "fluidsMl": 1500, "sodiumMg": 1200, "caffeineMg": 0, "kcal": 900 },
      "items": [
        { "offsetMin": -15, "label": "Line up in corridor", "what": "Get into position early",
          "kind": "action", "carbsG": 0, "fatG": 0, "proteinG": 0, "fluidsMl": 0,
          "sodiumMg": 0, "caffeineMg": 0, "kcal": 0, "notes": null },
        { "offsetMin": 30, "label": "Gel #2", "what": "25g carb gel, non-caffeinated",
          "kind": "fuel", "carbsG": 25, "fatG": 0, "proteinG": 0, "fluidsMl": 0,
          "sodiumMg": 50, "caffeineMg": 0, "kcal": 100, "notes": "Take on a flat or descent." }
      ]
    }
  ],
  "alerts": [
    { "severity": "danger", "title": "Cut-off — first 37km",
      "body": "Average 25 km/h for the first 37km or you are redirected to the short course." }
  ],
  "warnings": ["Average 25 km/h for the first 37km or you are redirected to the short course."]
}
```

## Acceptance criteria

- A freshly generated plan includes `kind` on every item, `macros` on each
  pre-race phase, and top-level `alerts` (plus `warnings` retained).
- Existing stored plans (no new fields) still validate and still load in the FE.
- `schemaVersion` is still `1`; no migration was added.

## Cross-repo note

Handoff is also logged in [WIP.md](WIP.md) and
[../fuelplan-shared/WIP.md](../fuelplan-shared/WIP.md). No FE changes are needed
when you ship this — the new sections appear automatically once the fields are
present.
