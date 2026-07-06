# Things to Try

The shared-SVG-library plan, as layers: 1 and 2 are implemented in `generator.ts`,
4 (the expected big win, and it was) is in `templates.ts` — seven kinds covering
21 of 30 dataset cases; 3 remains future — though once layer 4 covers a family,
a layer-3 skeleton for it buys little. After the layers: other things tried, and
smaller ideas.

## Layer 1: Deterministic SVG post-processing (done, kept)

`prepareSvg` in `generator.ts` rewrites every model-drawn SVG before rasterizing,
so the fixes hold even when the model ignores its instructions:

- **Text halos**: an injected `<style>` gives every `<text>` a white outline
  painted *under* the glyph fill via `paint-order: stroke` — labels stay readable
  on top of lines and shading, and the halo hugs the character shapes (no font
  metrics or background rects needed). Width scales with the viewBox.
- **Auto-crop to content** (replaced the original ~5% viewBox auto-padding,
  which survives only as a fallback): `renderPng` renders a probe pass, takes
  resvg's `getBBox()` of everything actually drawn, and re-renders with the
  viewBox cropped to that box plus a margin. Kills dead canvas space, and makes
  clipping structurally impossible — content drawn *outside* the declared
  viewBox comes back into frame instead of being cut off.
- **Font normalization**: forces sans-serif so rendering doesn't depend on the
  model's font pick.

Zero model cooperation required, free at inference time, and it kills two failure
classes the critic explicitly hunts for (clipped labels, lines through text).

## Layer 2: Injected defs + class vocabulary (done, kept — v2 after regressions)

`SVG_VOCABULARY_DEFS` in `generator.ts` is injected into every SVG by `prepareSvg`;
its prompt-facing twin `SVG_VOCABULARY_GUIDE` (kept adjacent so they can't drift)
teaches the model to reference it instead of hand-drawing the atoms it botches:

- **Markers**: `#arrow` (near-black; `#arrow-accent` survives only as a retired
  alias of it — see v2.2). resvg doesn't support `context-stroke`, so arrowheads
  can't inherit line color. It also doesn't support `orient="auto-start-reverse"`
  — that silently falls back to a fixed 0°, so every arrowhead rendered pointing
  right regardless of line direction (invisible on rightward arrows, glaring on
  axes). The markers use `orient="auto"`, and nothing may use `marker-start`
  (with `auto` it points backward into the line): a double-ended arrow is two
  lines drawn outward from the middle, each with `marker-end` — the guide and
  the layer-4 templates both follow this rule.
- **Symbols** (placed with `<use href>`): `#dot-filled`/`#dot-empty` counters,
  `#point-closed`/`#point-open` endpoints, `#right-angle`.
- **Classes**: `axis`, `tick`, `grid`, `label`, `title`, `shaded`, `unshaded`,
  `shade-1`–`shade-4` — the palette is grayscale-first per the principles doc
  (gray shading, gray context, near-black ink); color enters only at `shade-2`+,
  when categories must be told apart.

Defs are injected at the document start (so our ids win over duplicates the model
defines anyway); the layer-1 halo style stays at the end (so it wins the cascade).

### What v1 broke, and the v2 fixes

The first cut shipped the classes as an injected `<style>` block and pinned the
canvas to `viewBox="0 0 720 480"`. Uniformity improved across the board, but the
first benchmark run (`runs/2026-07-03T15-38-59-897Z`) broke three of six cases:

- **CSS clobbered the model's explicit styling.** A `<style>` rule beats
  presentation attributes, so `class="outline" fill="#4a90d9"` rendered white —
  d-04's "each bar a different color" came out as white outline bars.
  **Fix**: classes are no longer CSS. `expandVocabularyClasses` expands each
  vocabulary class into presentation attributes *only where the element doesn't
  already set them* — we implement the cascade ourselves, attributes-win. The
  vocabulary is a default, never a mandate.
- **`.outline` (white fill) was a semantic trap.** Models used it for container
  /border rects drawn over finished content, and the opaque white fill blanked
  the whole diagram (d-03's fraction bar rendered empty).
  **Fix**: renamed to `unshaded` with `fill: none` (`outline` kept as an alias,
  same safe values) — a misapplied class now degrades to "no styling" instead of
  "destroyed diagram". The guide also says borders/containers must use
  `fill="none"`.
- **The fixed 720-wide canvas forced awkward tick arithmetic.** The easiest case
  (d-01's 0–10 number line) regressed: non-round spacing made Haiku fumble the
  last tick. **Fix**: the guide now says to pick round unit spacing first (e.g.
  100/interval) and size the viewBox to fit (~600–1200 wide); the layer-1
  auto-crop makes canvas-size choice visually irrelevant.
- **Invented classes rendered invisible elements.** A `<line class="divider">`
  where the class doesn't exist defaults to `stroke: none` — d-03's dividers
  vanished silently. **Fix**: `fixInvisibleStrokes` gives a default stroke to
  any line (or `fill="none"` path/polyline) that would otherwise draw nothing;
  visible-but-plain beats silently missing. (Skipped when the model styles via
  group-level inheritance, which the tag-local check can't see through.)
- **Diagnosing all this was archaeology** — runs only stored PNGs. **Fix**: both
  harnesses now persist the raw model SVG (`<case>.svg`, pre-`prepareSvg`) next
  to each PNG.

Re-test with the same six cases (`LIMIT=6 bun run bench`) against the
"does SVG_VOCABULARY_GUIDE improve pass rate?" journal hypothesis.

### v2.1 field notes (from the first v2 runs)

d-01's number line came back perfect — round spacing + auto-crop worked. d-03
exposed two more rough edges, diagnosed from the persisted `d-03.svg`:

- **White bold labels fought the halo.** The model used `fill="#fff"` for
  contrast on shaded cells; white glyphs merge with the white halo into
  fattened blobs, and looked inconsistent next to the dark label on the
  unshaded cell. **Fix (deterministic)**: `normalizeTextFills` rewrites
  white-ish text fills to near-black — the halo already guarantees dark text
  reads on any fill — plus a guide line saying never use white text.
- **Part tiling still done by in-head arithmetic.** Three "equal" parts drawn
  as 60-wide cells with 10px gaps inside a 200-wide border (200/3 ≈ 66.7 was
  too hard). A guide line now spells out the tiling recipe (one part size =
  total/parts, shared edges, no gaps, worked example) — but this failure class
  is exactly what layer 4 templates eliminate; if it recurs, that's the cue to
  build `fractionBar` first rather than more prompt text.

### v2.2: grayscale-first alignment

The v1/v2 vocabulary used a blue accent (`shaded`, `#dot-filled`,
`#arrow-accent`) — a K-12-convention choice that contradicted the principles
doc ("grayscale first", "light gray vs. black beats red vs. blue"), which the
evaluator also judges against, putting generator defaults and judge at odds.
Now: `shaded` is mid-gray (#c4c4c4), `#dot-filled` near-black, `#arrow-accent`
retired (aliased to `#arrow` so stale references still render a head), and
`shade-1` is a darker gray so single-series charts stay grayscale — color
starts at `shade-2`, for the requests that explicitly demand distinct colors.
If the friendly blue turns out to matter for young students, the right move is
a written K-12 exception in `docs/visualization-principles.md` (it steers both
generator and judge), not colored defaults.

### v2.3: guide tweaks from the first full run

The first full-dataset run (`runs/2026-07-03T16-20-44-392Z`: 20/29 pass, mean
3.81) put 7 of 9 failures in the scale/count-arithmetic class — the layer-4
failure class, recurring exactly as v2.1 predicted. Prompt-side mitigations
added to the guide (worth one run, but if the class persists the answer is
layer 4, not more prose):

- **Fencepost rule**: an axis from A to B with ticks every s has (B−A)/s + 1
  ticks; iterate the *values*, and the last tick lands exactly at B (d-26's
  axes stopped at 4/−4 instead of 5/−5; d-07 squeezed 1→2 to a quarter of the
  0→1 length).
- **One-scale rule**: pick one px-per-unit scale and compute every labeled
  measurement from it (d-29's bar labeled 7 reached the 9-gridline; d-30's
  6 cm and 8 cm legs came out near-equal; d-08's prism ignored its 5:3:2
  labels).
- **2-D tiling recipe**: m×n grid = exactly m·n cells at computed positions;
  count what you drew before finishing (d-22 drew a 4×4 grid for "4 × 6";
  d-27's combined array had 16 dots where the label said 22).
- **Don't label the answer**: when the Purpose says students will count,
  interpret, or find something, that answer doesn't get printed on the diagram
  (d-12 wrote the count next to each dot stack it wanted students to count;
  also d-02's "1"-in-each-half quibble).
- **Title band**: the title sits alone at the top — two cases had labels
  colliding with it (d-07's "+1/2" corrupted the title into "Adding Jú1/2ps",
  d-22's "6 columns" ran under it).

Plus one deterministic fix, promoted from the smaller-ideas list: `prepareSvg`
now enforces text-last layer order (`hoistTextToEnd`) — rendered `<text>` moves
to the end of the document so labels always paint on top, with copies of the
ancestor `<g>` tags re-wrapped around the moved text so inherited transforms
and styles survive; text inside defs/symbol/marker or non-`<g>` containers
stays put. Combined with the halo this makes line-through-label collisions
structurally impossible: re-rendering this run's saved SVGs fixed d-28 outright
(ticks pierced "12" and "6", the hour hand covered "3") and d-12's
guides-through-labels, with passing cases unchanged. Text-on-text collisions
(d-07's label-into-title) remain out of its reach — that's the title-band
guide line's job.

## Layer 3: Few-shot skeletons in the prompt

Add a ~15-line canonical SVG exemplar per diagram family to `GENERATOR_SYSTEM_PROMPT`
("here is how a number line looks", "here is a fraction bar"), written in the
layer-2 vocabulary.

- **What it buys**: standardizes *composition* decisions the vocabulary can't —
  margins, where labels sit relative to ticks, bar spacing, jump-arc shapes.
- **Cost**: prompt tokens on every generation call, and it's guidance rather than
  guarantee — the model can still drift.
- **How to evaluate**: `pnpm bench` A/B against the current prompt; watch draft pass
  rate and evaluator scores per family.
- **Note**: once layer 4 exists for a family, its exemplar buys little — consider
  skeletons only for families that stay on the raw-SVG path.

## Layer 4: Parameterized templates / DSL — where the scale bugs die (v1 + v2 done: 7 kinds)

Layers 1–3 don't fix the most damning failure class the critic checks for:
out-of-scale drawings (a bar labeled 9 ending at 8.5, uneven tick spacing). Those
come from the LLM doing coordinate arithmetic in its head. The fix is having code
compute positions: the model emits a small JSON spec, deterministic TypeScript
renders it to SVG.

### v1 (shipped): `templates.ts`

`DiagramSpec` (`numberLine` | `barChart`, Schema-validated) + `renderSpec`, with
the prompt-facing `SPEC_GUIDE` kept adjacent so schema and doc can't drift. The
system prompt now leads with the spec path ("if the request is a NUMBER LINE or
BAR GRAPH…") and keeps raw SVG as the fallback for everything else. Covers 8 of
30 dataset requests (d-01/07/11/18/19 number lines, d-04/17/29 bar charts).

- **Positions accept `"2/3"` fraction strings**, resolved (and used as the
  default tick label) by the renderer — making the model divide 1/6 into 0.1667
  would reintroduce exactly the arithmetic this layer kills. `numberLine` does
  ticks/labels, custom fraction ticks, open/closed marks, shaded spans with
  arrow continuation (inequalities), jump arcs, and section brackets (d-19);
  `barChart` does title/axis/gridlines with bar top = value·px by construction.
- **Escape hatch is fenced-block dispatch, not `{"kind":"rawSvg"}`**: the model
  replies with EITHER a ```json spec or a ```svg block; extraction tries the
  spec first, falls back to the `<svg>` regex. JSON-escaping a whole SVG
  document was an escaping minefield, and this keeps the raw path byte-identical
  to before. A found-but-broken spec does NOT fall through — it fails as
  `SpecInvalid` (retryable, like `SvgNotFound`) so the retry gets a fresh draw.
- **Templates style via the layer-2 vocabulary only** (classes + `#symbol` ids,
  no own `<defs>`), so output flows through `prepareSvg`/auto-crop unchanged and
  shares one look with the raw path.
- **Per-path telemetry**: runs record `via: "spec" | "svg"` per case and persist
  `<case>.spec.json` next to the PNG/SVG.
- **First smoke run** (`runs/2026-07-03T16-38-22-596Z`, LIMIT=6): d-01 and d-04
  both took the spec path — provably even ticks, bars ending exactly at 9/6 —
  and the four raw cases were unaffected. Watch: d-12/d-16/d-25 must keep
  arriving `via: "svg"` (fraction strips *sound* like number lines); if they
  get captured, tighten the SPEC_GUIDE negatives.

### v1.1 field notes (from the first full run, `runs/2026-07-03T16-39-31-604Z`)

Routing was perfect — all 8 template-eligible cases chose the spec path, all 20
raw cases (including the fraction strips) stayed raw. Three findings:

- **The schema was stricter than the model's (correct!) instincts.** d-19's
  spec said `"tickEvery": "1/6"` — a natural read our number-only field
  rejected, and the no-fall-through policy meant three `SpecInvalid` retries
  and *no image at all*. **Fix**: `tickEvery`/`labelEvery` accept fraction
  strings, and a fractional spacing also makes the regular tick labels read as
  unsimplified fractions (0, 1/6, 2/6, …, 1) — which is what the request
  wanted anyway. Lesson for future fields: wherever a value is conceptually a
  position/spacing, accept `Pos`, not bare numbers.
- **A truncated raw reply masqueraded as a spec.** d-10 (blank clock) dies at
  `finishReason: length` — Haiku hand-computes 60 sin/cos minute-mark
  coordinates and blows the 4000-token cap; it has failed this way in 4 of 5
  historical runs, so it's chronic and pre-layer-4. New wrinkle: the truncated
  reply has no `</svg>`, so the bare-`{…}` spec fallback grabbed a CSS block's
  braces and reported a misleading `SpecInvalid`. **Fix**: the bare-JSON
  fallback only fires when the braces contain `"kind"`. The real fix for d-10
  is the `clock` template (v2 list) — code emits 60 marks in a loop, no
  token blowup, exact hand angles; an interim option is raising `max_tokens`.
- **The spec path can't fix comprehension.** d-07 rendered a clean, perfectly
  scaled number line of the *wrong* spec — the model misread "jumps of 1/4,
  1/2, 1/4 landing at 1/4, 3/4, 1" as landings at 1/4, 1/2, 3/4. Layer 4
  moves failures up the stack: from geometry (fixable by code) to reading
  (needs better examples — a jumps example in SPEC_GUIDE showing from/to
  accumulation is the cheap next bid).

### v2 (shipped): clock, coordinatePlane, linePlot, fractionBar, fractionCircle

The v1.1 full runs justified expanding immediately: every repeat-failing raw
case mapped onto a planned template. Five more kinds in `templates.ts` put
21 of 30 dataset cases on the spec path:

- `clock` — blank face or exact computed hands ("hour hand just past 3" at
  3:15 is a precise 97.5°); also kills d-10's chronic no-image death (Haiku
  hand-computing 60 minute-mark coordinates blew the 4000-token cap; a loop
  doesn't).
- `coordinatePlane` — named that instead of `grid` on purpose: "grid" invites
  d-22's area model and d-24's base-ten flats (both "grids of squares", both
  belong on the raw path) to get captured. Arrowheads only where the plane
  continues (first-quadrant grids get +x/+y only).
- `linePlot` — numberLine-style axis + counted `#dot-filled` stacks.
- `fractionBar` — parts+shaded (d-03/20), or total+partSize for measurement
  strips where the renderer computes how many parts fit (6 ÷ 1/4 = 24; the
  guide says NEVER compute the count yourself). All bars share one drawn
  length, left-aligned, for equivalence comparisons (d-20).
- `fractionCircle` — equal sectors from 12 o'clock, first N shaded.

First v2 run (`runs/2026-07-03T16-59-20-891Z`): **25/30 — best on record at
the time** (baseline 22, v1.1 runs 21 and ~19; a later same-day no-rewrite
baseline, `runs/2026-07-03T17-31-12-111Z`, reached 27/30 at mean 4.42 — the
current best). Spec path 20/21 with routing exactly as
designed — all 21 intended cases took it, every clock/plane/line-plot passed,
d-10 produced a passing image. The findings:

- **The one spec fail (d-25) is judge ambiguity, not geometry.** The request
  is self-contradictory ("a 5-foot strip divided into 3 equal sections each
  labeled 1/3 foot" — that sums to 1 ft) and the judge flips interpretation:
  it failed v1.1's literal 3-section drawing for bad math, then failed v2's
  consistent 15-section drawing for "revealing the answer" — while passing
  the structurally identical d-16 at 4.5 the same run. No template fix
  exists; this is the "per-request rubrics" entry's problem to solve.
- **Remaining raw fails are the geometry family** (d-05 parallelogram, d-08
  prism, d-22 area model, d-30 right triangle — and they churn run to run).
  Next templates if scores justify: `arrayModel` (d-06/09/22/27),
  `baseTenBlocks` (d-24); geometry helpers or composite template+overlay
  specs (punted from v1) for d-05/08/14/30.

### v3 (shipped, `model-hunt` worktree): six kinds close the raw-SVG path entirely

The model hunt below found every cheap model dying on the same cases — the ones
that fell through to raw SVG. So the DSL grew six kinds targeting all 8 remaining
raw-path dataset cases: `tenFrame` (d-06), `dotArray` (grouped; d-09 set model,
d-27 addition groups), `areaGrid` (d-22), `baseTenBlocks` (d-24), `shape`
(rightTriangle d-30, parallelogram d-05 — numeric base/height set the drawn
proportions, so legs labeled 6 and 8 really draw 3:4), and `rectPrism` (cabinet
projection, hidden edges dashed; d-08, d-14 side-by-side shaded prisms).

- First full run with the expanded guide (`runs/2026-07-06T16-20-15-918Z`):
  **all 30 cases arrived `via: "spec"`** — the raw-SVG path went unused for the
  first time, and every one of the 8 target cases scored 4–5 except d-27 (3,
  judge wanted "colorful/rainbow" and the model picked the gray slot — fixed by
  starting the default shade cycle at the color slots and saying so in the guide).
- The same run lifted Haiku itself 27/30 → 28/30 (`runs/2026-07-06T16-23-22-025Z`),
  so the expansion pays regardless of the model swap.
- Watch item: with zero raw-SVG traffic on the dataset, regressions in the raw
  path are now invisible to the bench — the smart-routing idea (flag off-DSL
  requests) matters more, not less, once the dataset grows past the DSL.

## Model hunt: 10x cheaper generation via OpenRouter (done — swap to gpt-oss-120b, price-sorted)

Hypothesis: Haiku 4.5 ($1/$5 per M) is overkill for "read a request, emit a
small JSON spec" once the DSL carries the geometry — an open-weights model at
$0.03–0.15/M input should hold quality at ~10x less cost, and fast-inference
hosts (Groq/Cerebras, 300ms–1.5s generations) might also buy speed.

Method: `GENERATOR_MODEL` / `GENERATOR_PROVIDER` / `GENERATOR_SORT` /
`GENERATOR_REASONING` env overrides on the generator (run.json records `model`),
6-case smokes over 6 candidates, then full 30-case runs for the finalists.
Baseline: Haiku 4.5, 27/30 pass, p50 13.2s, $0.0052/case
(`runs/2026-07-03T17-31-12-111Z`).

Smokes (6 cases): gpt-oss-120b 6/6 · gemini-2.5-flash-lite 4/4 + 1 dead case ·
qwen3-30b, gpt-oss-20b, glm-4.7-flash all 4/6. Every failure clustered on the
raw-SVG cases (d-05/d-06) — which is what motivated DSL v3 above, and it held:
with the expanded DSL the cheap model's failures vanished.

Full 30-case runs, gpt-oss-120b `reasoning: low` + DSL v3:

| routing | pass | p50 | $/case | vs baseline |
| --- | --- | --- | --- | --- |
| default | 26/30 | 11.6s | $0.00088 | 5.9x |
| `sort: "price"` (→ DekaLLM $0.038/M) | **28/30** | 13.6s | **$0.00016** | **32x** |
| pinned Groq ($0.15/M) | 25/30 | 12.0s | $0.00051 | 10.2x |
| Haiku 4.5 control + DSL v3 | 28/30 | 13.0s | $0.00460 | 1.1x |

The price-sorted config **matches the Haiku+DSL control's 28/30** at 1/28th the
cost. Run-level p50 is flat across all configs (~12–13s) because the bench fires
all 30 cases concurrently (`concurrency: "unbounded"`) and the harness, not the
model, sets the pace.

### Sequential speed A/B (done): the 13s baseline p50 was the harness, not Haiku

`CONCURRENCY=1` full runs, measuring what a user actually feels per diagram:

| config (sequential) | pass | p50 | p90 | max | $/case |
| --- | --- | --- | --- | --- | --- |
| gpt-oss-120b `sort: "throughput"` (→ Cerebras 19, Groq 5, Nebius 5, Mara 1) | 28/30 | **1.4s** | 3.5s | 8.2s | $0.00104 |
| Haiku 4.5 (`runs/2026-07-06T16-46-03-201Z`) | 27/30 | 2.1s | **2.5s** | **2.9s** | $0.00431 |

Two honest findings:

- **Per-case, the model swap is ~1.5x at p50, not 10x — and Haiku wins the
  tail** (p90 2.5s vs 3.5s; the fast hosts have queue/retry spikes). The 13.2s
  recorded baseline p50 was ~6x harness contention: 30 concurrent cases queue at
  the provider and fight the local renders/eval fibers. Latency is measured
  inside each case's fiber (the benchmark comment says concurrency doesn't
  inflate it), but wall time inside the fiber genuinely rises under contention.
- **The DSL is the real speed feature.** With every case emitting a 40–80 token
  spec instead of hundreds of lines of SVG, even Haiku is a ~2s generator. The
  10x-vs-recorded-baseline framing (13.2s → 1.4s) is true but mostly credits
  measuring without contention.

So the speed menu, all at unchanged-or-better quality: `sort: "price"` = 29x
cost, ~2s/case sequential; `sort: "throughput"` = 5x cost, ~1.4s/case p50 (worse
tail). Cost is the axis where the model swap genuinely wins; per-case latency
was already good once the DSL landed, and the remaining fixed overhead
(~0.5–1s: OpenRouter hop + the two-pass auto-crop render) now rivals the model
time.

### The fixed overhead was font scanning (done, kept — ~355ms of every render)

Chasing that overhead: `new Resvg()` rebuilds its font database on every
construction, and scanning the system fonts costs ~355ms of the ~360ms render
(measured on real run SVGs; with `loadSystemFonts: false` a render is 2ms).
`renderPng` constructs two instances per case (probe + final), so a 30-case run
paid ~21s of blocked event loop — which is exactly the "unaccounted" client-side
gap in the concurrent-run analysis above, and why unbounded runs sat at ~13s p50
regardless of model. resvg was never slow; it was 60 redundant font scans.

Fix: `RENDER_OPTIONS` now loads only the bundled DejaVu files (the same fonts
the Worker deploy renders with — local and deployed PNGs now match), guarded on
Bun so the Worker's wasm shim keeps injecting its own font buffers. Retest,
full 30 cases each:

| config | pass | p50 | p90 | $/case |
| --- | --- | --- | --- | --- |
| gpt-oss-120b `sort: "throughput"`, sequential | 27/30 | **0.55s** (was 1.4s) | 1.7s | $0.00108 |
| Haiku 4.5, sequential | 27/30 | 1.6s (was 2.1s) | 1.8s | $0.00460 |
| **shipped default** (price-sorted, unbounded 30-way) | 28/30 | **3.7s** (was 13.6s) | 9.5s | **$0.00017** |

Final tally vs the original recorded baseline (Haiku, 27/30, p50 13.2s,
$0.0052/case, same unbounded harness): the shipped default is **30x cheaper and
3.6x faster at equal quality**; per-diagram on fast hosts the pipeline now draws
in ~0.55s (24x below the old recorded p50 — though most of that is the DSL and
this font fix, not the model). Remaining latency levers if ever needed: skip the
auto-crop probe on the spec path (template viewBoxes are already correct) and
`renderAsync` for the final pass.

- Reasoning models need `reasoning: { effort: "low" }` on this task — thinking
  tokens are pure cost/latency for a JSON-spec emission (Cerebras runs showed
  8–35 reasoning tokens even at low; fine).
- A provider *pin* is not a price floor: pinning `mara,wandb,deepinfra` still
  landed on DeepInfra's $0.15/M endpoint. `provider.sort: "price"` is what
  actually reaches the $0.03–0.04/M endpoints.
- Replication (bench-noise section applies): two more price-sorted runs came in
  26/30 and 26/30 (`runs/2026-07-06T16-25-06-120Z`, `…16-26-23-890Z`; avg score
  4.28/4.25 vs the control's 4.53) — mean 26.7 vs the pre-DSL Haiku baseline's
  recent full runs (22–27, mean ~24). Quality is at parity within noise; the
  cost cut is not noise (mean $0.00018/case across the three runs, 29x).
- The recurring fails are model-independent: d-12 (3.5, all three runs — chronic
  linePlot borderline), d-19 (2–2.5 — also failed the Haiku control), d-25
  (flipped in 2 of 3 — the model sometimes omits `partLabel`; the request is the
  self-contradictory "5 ft in 3 sections of 1/3 ft" one, and the judge reads it
  the other way when labels go missing).
- d-27's "colorful" miss was fixed between run 1 and the replicates by starting
  dotArray's default shade cycle at the color slots — it passed in both.

Put real (request, SVG) pairs in `GENERATOR_SYSTEM_PROMPT`: an actual dataset
request followed by a great SVG we generated for it. Kin to layer 3, but instead
of hand-authored skeletons, harvest winners — the explorer already highlights best
runs, and both harnesses now persist the raw model SVG per case, so top-rated runs
are a ready-made exemplar pool.

### What we tried (2026-07-03, `fewshot-exemplars` worktree)

Attempted to *farm* the exemplar pool instead of waiting for winners: (1) wrote
30 fresh prompts, (2) had Sonnet (not Haiku) draw them, hoping the stronger
model would yield great examples worth pasting into the prompt. After ~20
minutes: not an immediate win, parked.

- **Sonnet makes the same geometry mistakes.** Surprisingly it also botched
  d-04, putting the number line on the wrong axis; and it messed up arrowhead
  rotations. A bit better at clocks than Haiku, but still not good enough to
  serve as an exemplar.
- **Takeaway**: "use a stronger model to generate the few-shot examples" doesn't
  route around the in-head-coordinate-arithmetic failure class — it reproduces
  it. That's more evidence for layer 4 (code computes positions) over any
  prompt-side scheme, and it means the exemplar pool has to come from *verified*
  winners (human-passed cases in real runs), not from a one-shot stronger-model
  sweep.

- **What it buys over layer 3 skeletons**: exemplars show the full mapping from
  request wording to finished output (how to interpret "with no answer shown",
  what to label, how much detail), not just what a family looks like. And they're
  free to produce — we already generated them.
- **Curation beats quantity**: 2–3 verified-great pairs likely beat 10 mediocre
  ones; a wrong exemplar teaches the wrong lesson at scale. Re-curate as the
  vocabulary evolves (a winner from before layer 2 v2 models its absence).
- **Prompt bloat control**: full SVGs are big. Options: include only 1–2 pairs;
  strip comments/whitespace; or go retrieval-style — pick the exemplar whose
  request is most similar to the incoming one (nearest family) instead of sending
  all of them every call.
- **Watch for anchoring**: models copy exemplars hard. Check that a number-line
  exemplar doesn't drag bar-graph requests toward number-line layouts, and that
  values from the exemplar don't leak into other diagrams.
- **How to evaluate**: same as layer 3 — `pnpm bench` A/B, watching per-family
  scores and draft pass rate.

## Strip the raw-SVG curriculum from the prompt (done, kept — 35% cost cut, no quality change)

Hypothesis: with all 30 dataset cases on the spec path, the prompt's raw-SVG
curriculum — the vocabulary guide (~1.5k tokens) and the visualization-
principles doc (~0.4k) — teaches a skill the model no longer uses, and input
tokens are ~95% of generation cost. Removing them should cut cost with no
quality change.

The lean prompt keeps the Visual/Purpose rules, the PREFERRED/FALLBACK reply
shapes, and the full SPEC_GUIDE, and replaces the curriculum with a three-line
fallback cheat sheet (canvas conventions + a bare list of the injected
classes/symbols). 3,572 → 2,064 input tokens.

A/B, full 30-case runs, shipped default config otherwise:

| prompt | pass | $/case | via spec |
| --- | --- | --- | --- |
| full (`…17-15-06-839Z` + two pre-font-fix runs) | 28, 26, 26 | $0.00016–21 | 30/30 |
| lean (`…17-26-48-393Z`, `…17-27-49-438Z`) | **29**, 25 | **$0.00011** | 30/30 |

Pass rate indistinguishable (lean mean 27 vs full 26.7; the 29/30 lean run is
the best run of the project, avg score 4.53). Failures are the same chronic
set either way (d-19, d-12, d-25 — none of them raw-SVG cases). Spec adoption
stayed 30/30, so the routing never leaned on the curriculum. Now the default;
`FULL_PROMPT=1` restores the curriculum for A/Bs.

- Caveat, same one as DSL v3: the dataset no longer exercises the raw path, so
  this A/B can't see raw-fallback degradation. An off-DSL request now draws
  from the cheat sheet alone — plainer output, still valid SVG, and the
  injected defs/classes still expand if the model reaches for them. If the
  dataset grows past the DSL, re-run this A/B on the off-DSL slice before
  trusting the lean prompt there.
- The visualization-principles doc still steers the *evaluator* (it scores
  against it) — it left only the generator's prompt.
- prepareSvg (halos, hoisting, auto-crop, class expansion, defs) was NOT
  removed: it costs ~3ms/case post-font-fix, and on the spec path it's what
  makes template output styled at all (templates emit classes on purpose).
  The only spec-path candidate left is the auto-crop probe (template
  viewBoxes are already correct) — parked as a simplification, not a win.

## Visualization principles in the prompt (tried, kept — good lift)

Bring great visualization principles into the generator as a prompt-improvement
bid. We distilled them from Edward Tufte into `docs/visualization-principles.md`,
which is imported directly into `GENERATOR_SYSTEM_PROMPT` (and so also steers the
reviser, and is what the evaluator judges against).

- **Status**: in place, and it seems to give some good lift.
- **Why it works double duty**: the same doc serves as drawing rules for the
  generator and as judging criteria for the critic/evaluator, so the whole loop
  pulls in one direction.
- **Possible follow-ups**: distill principles from other sources (e.g. math-ed
  specific guidance on representations), or let the evaluator's
  `suggestedSystemPrompt` loop propose edits to the principles doc itself.

## Strip the "Purpose" from generation prompts

Dataset requests arrive as `Visual: ... Purpose: ...`, and the Purpose is a
trap: d-15 ("Purpose: students name the shaded fraction and compare it to one
half") came back with the answer printed on the diagram — a "Shaded: 5/8"
caption plus a whole worked comparison-to-1/2 panel. The generator treated the
students' task as content to draw. The system prompt now has an explicit
"draw only the Visual, never solve the Purpose" rule; the harder-line variant
is to not show the model the Purpose at all.

- **The experiment**: A/B with `pnpm bench` — (a) full request + the
  don't-solve-it rule vs (b) request with the `Purpose:` clause stripped before
  it reaches `createDiagram`. Watch answer-leak failures specifically (d-15 and
  kin), plus overall scores.
- **What stripping might cost**: the Purpose sometimes carries real drawing
  signal — what to leave unlabeled ("students count the dots" implies no count
  label), emphasis, grade level. Pure stripping tests whether that signal is
  worth the leak risk.
- **Middle ground if (b) wins on leaks but loses elsewhere**: keep stripping,
  but let a cheap pre-pass translate the Purpose into negative drawing
  constraints ("do NOT label the total") appended to the Visual.
- **Note**: the evaluator should keep seeing the full request either way — the
  judge needs the Purpose to know what counts as giving the answer away.

## Sonnet rewrites the teacher's request into a drawing brief for Haiku (implemented — early A/B negative)

The evolution of the strip-the-Purpose idea above, after living with the
ignore-the-Purpose rule for a while. **Why**: the Purpose confuses Haiku, and
telling it to ignore the Purpose helped a lot — but sometimes crucial drawing
content hides in there. d-10 is the clean example: "Purpose: Grade 1 students
draw hour and minute hands … (multiple blank clocks needed for practice)" —
*how many clocks to draw* lives in the Purpose. A blanket ignore-it rule (or
hard stripping) loses that; keeping it risks the d-15 answer-leak class. The
Visual/Purpose split just isn't a clean draw-this/skip-this split — reading
comprehension is needed to sort one from the other.

- **The idea**: a Sonnet pre-pass translates the teacher's raw request into an
  explicit, self-contained drawing brief for Haiku — everything that must be
  drawn pulled forward (d-10's "several identical blank clocks"), the student
  task translated into negative constraints ("do NOT draw hands, do NOT label
  times"), and the Purpose itself gone. Division of labor mirrors layer 4's
  thesis: move interpretation to the model that's good at it, leave Haiku a
  literal spec.
- **Cost/latency accounting**: unlike the evaluator, the rewrite sits ON the
  generation path — its generation id belongs in `generationIds` and its time
  in `latencyMs`, so rollups stay honest. A text-only Sonnet call is small
  (~1–3s); the dataset is static, so caching rewrites by request hash amortizes
  it to zero for repeat benches if the idea sticks.
- **The judge keeps the original**: the evaluator must score against the
  teacher's request (Purpose included — it defines what "giving the answer
  away" means), never the rewrite. Persist the brief per case for diagnosis.
- **How to evaluate**: A/B via `pnpm bench` behind a flag — watch d-10 (does
  the multi-clock requirement survive?), d-15 and kin (answer leaks), and
  whether briefs help or hurt the cases that were already passing.

### Status: implemented behind `REWRITE=haiku|sonnet`; first results negative

`resolveRewriter` in `generator.ts` picks the pre-pass model (`haiku` added as
the cheap variant of the same experiment; legacy `REWRITE=1` still means
sonnet), briefs are persisted per case as `rewrittenRequest` + `rewriteModel`,
the explorer's bench bar has a rewrite-model dropdown, and history rows label
which model wrote a run's briefs. A failed rewrite falls back to the raw
request.

Every rewrite sample so far scored below the same-day no-rewrite baseline
(27/30, mean 4.42):

- **Sonnet briefs**, two 6-case smokes (`runs/2026-07-03T17-09-57-846Z`,
  `…17-14-29-341Z`): 4/6 both, means 3.75 / 3.67 — even d-01's easy number
  line failed once.
- **Haiku briefs**, full run (`runs/2026-07-03T17-35-29-314Z`): 22/29 rated,
  mean 3.83 — and d-10, the case that motivated the whole idea, produced **no
  image at all**: the haiku pre-pass returned an *empty* brief, the generator
  drew from the empty string, and all three attempts died `SpecInvalid`.
  **Unshipped fix**: treat an empty/blank brief as a rewrite failure so the
  fallback-to-raw-request path fires; worth shipping even if the idea parks.

These are single noisy samples (see the statistical-footing entry), but the
direction is consistent, and a plausible reading is that the idea aged out:
the ignore-the-Purpose rule plus layer 4's spec path already cover most of
what the rewrite was for, so the brief now mostly adds a lossy paraphrase
between the teacher and the generator. Worth one clean N=3 A/B before
declaring it dead.

## Inline generate → critique → revise loop (tried, parked — too slow)

A single generate → critique → revise round inside `createDiagram`: a stronger
vision model (Sonnet) reviews the rendered draft against the request, and the
drafting model patches its own SVG when issues are found.

- **Status**: tried, but too slow — sometimes 60+ seconds spent on the critique
  alone. We moved the verification value over to the evaluator instead, which
  gives us automatic verification as LLM-as-judge without sitting on the
  generation path.
- **Not necessarily a dead end** — just not worth the squeeze right now/yet.
- **Future things to try if revisited**:
  - Haiku as the critic (much faster; the layer-1/2 work may have made the
    remaining failure classes simple enough that a cheap critic catches them)
  - Fan out multiple critiques in parallel and merge the issues
  - Better critique prompts (tighter scope, shorter inspection, faster verdicts)

## Rendering as HTML/CSS instead of SVG (tried briefly, parked)

Have the model emit HTML/CSS and screenshot/rasterize that, instead of SVG.

- **Status**: tried on 2026-07-03, stopped after ~20 minutes of spinning wheels /
  messing around. A more thoughtful deep dive could still be useful.
- **What the quick attempt showed**: the SVG output was better scaled and simpler
  than the HTML/CSS equivalents — SVG's explicit coordinate space seems to suit
  these diagrams better than fighting CSS layout for precise geometric placement.
- **If revisited**: worth deciding up front what HTML would actually buy (e.g. free
  text flow/wrapping, flex/grid for evenly-spaced partitions?) and testing just
  that hypothesis, rather than porting whole diagram families.

## Retry on hard failures (done, kept)

`createDiagram` used to die outright if the draft had no extractable `<svg>` or
resvg couldn't render it — no second attempt. "No image at all" matters more
than "mediocre image", so the whole draft → extract → render pipeline now
retries up to 2 extra times with exponential backoff (500ms, 1s), but only for
failures a fresh attempt can fix:

- our own `SvgNotFound` / `SvgUnrenderable` — a bad sample; a fresh draw
  usually succeeds
- provider errors the AI library classifies as transient via
  `AiError.isRetryable` (network, rate limit, provider internal)

Auth, quota, content-policy, and invalid-request errors fail fast — retrying
those wastes time and money. Failed attempts' generation ids are still recorded
(they're paid calls), so `generationIds.length > 1` doubles as the "retries
happened" signal in the harness.

**Failure history (added after d-10 died blind)**: the ids-are-recorded claim
above was only true when a retry eventually *succeeded* — a case whose every
attempt failed (d-10, `SvgNotFound` after 62s in the first full run) reached
the harness as a bare error name: no generation ids (spend invisible, cost
recorded as $0), no drafts (undiagnosable). Now `createDiagram`'s terminal
failure is a `DiagramFailed` carrying the whole story — every generation id
across attempts, plus each attempt's error and full raw model reply — and both
harnesses persist it: ids go into the manifest (so the post-run cost lookup
counts the paid calls), each received draft is written to
`<case>.attempt-N.txt` next to the run artifacts (the failure-side twin of the
`<case>.svg` successes get), and the manifest's `attempts` field records
per-attempt errors with the draft filenames. A successful explorer rerun
clears a stale `attempts` entry.

## Benchmark noise / statistical footing

Several entries in this doc say "A/B with `pnpm bench`" — but one sample per
request at default temperature is noisy, and a layer can look like +0.3 score on
pure variance. Every "did layer X help?" answer is shaky until this is addressed.

- **N runs per request** when comparing variants (even N=3 changes the picture);
  compare means and look at per-case flips, not just the aggregate.
- **Lower generation temperature** for benchmark runs so variants differ by
  prompt, not by sampling luck.
- **Judge calibration anchors**: LLM-judge scores drift too. Pin a few reference
  PNGs with known scores and check the judge still assigns them before trusting
  a comparison run.

## Per-request rubrics for the judge

Each dataset request contains precise checkable facts ("Lions bar reaches 9",
"open circle at 3", "hour hand just past 3"). Derive a one-time checklist per
request — an LLM call whose output is cached alongside the dataset — and hand it
to the evaluator.

- Turns "judge this holistically" into "verify these ~6 facts": cheaper, more
  reproducible, and score changes across runs become interpretable (which fact
  flipped?).
- The rubric is reusable across every run of that request forever, so the
  derivation cost amortizes to zero.
- Pairs well with the statistical-footing entry above: fact-level pass/fail is
  a much lower-variance signal than a 0–5 holistic score.

## The classroom, not the screen

Nothing else in this doc thinks about where these diagrams actually land:
printed and photocopied worksheets, viewed by young students.

- **Grayscale survival**: blue shading becomes mid-gray on a copier — does
  `shaded` vs `unshaded` still read? Do `shade-1`–`shade-4` stay distinguishable
  in grayscale (and to colorblind students)? Cheap test: render the bench set to
  grayscale and look.
- **Grade-level sizing**: a kindergarten ten-frame wants chunkier strokes and
  bigger labels than a grade-8 inequality plot; the vocabulary currently fixes
  one scale for all. The request text usually names the grade — the prompt (or a
  vocabulary variant) could use it.

## Smart routing when the DSL doesn't cover the request (not tried)

Today an off-DSL request falls back to Haiku writing raw SVG — the weakest path
in the pipeline. Instead, route it: when the model can't reach for a template,
send that request to a stronger model for the raw-SVG draw, and **flag the
instance**. The flag stream is the real prize — it's a running census of which
diagram families educators actually ask for that the DSL doesn't cover yet, i.e.
a prioritized backlog for the next template.

- The `via: "spec" | "svg"` telemetry already in run.json is half of this;
  routing just acts on it at generation time instead of reading it afterward.
- Caveat from the few-shot experiment: Sonnet makes the same in-head-geometry
  mistakes, so routing buys comprehension and composition, not arithmetic — the
  arithmetic fix is always another template. That's why the flag matters more
  than the fallback quality.

## The evaluator is saturating (needs improvement)

The judge got us from "eyeball it" to a climbable metric — pass/fail, 0–5, and
a critique (the critique was often the only window into what the judge was
thinking, and drove several judge-prompt fixes). But at 27/30 passing, the top
of the scale is crowded: real quality differences between runs land inside the
judge's noise band (see d-25's interpretation flip-flops), and further generator
work can't be measured against it reliably.

- The per-request-rubrics entry below is the main fix: verify ~6 checkable facts
  per request instead of holistic scoring.
- The calibration-anchors idea (statistical-footing entry) is the cheap
  guardrail: pin reference PNGs with known scores, check the judge still assigns
  them before trusting a comparison run.
- Human overrides (pass/fail chips, score edits) exist in the explorer and saw
  real use — accumulated overrides double as a judge-vs-human disagreement set
  to tune the judge against.

## Grow the dataset: 30 → ~100 cases

Thirty requests was right for a day of iteration; it's too few to (a) trust
pass-rate deltas (one flipped case = 3.3 points), (b) cover the long tail of
what educators ask for, or (c) tell whether the DSL's 21/30 coverage is a
ceiling or an artifact of the sample. Mine real educator asks for another ~70
cases, keep the same jsonl shape, and expect the exercise to surface which new
DSL kinds (or which smart-routing flags) matter — expanding cases and expanding
the DSL are the same project seen from two ends.

## Evaluate the DSL against open-source diagram libraries

The DSL currently renders through our own ~30KB of template code. Before it
grows much further, check the buy-vs-build line: could `numberLine`/`barChart`/
`coordinatePlane` specs compile to an existing renderer (mafs, JSXGraph,
function-plot, or even matplotlib server-side) instead of hand-rolled SVG?

- What the libs would buy: tested geometry, more diagram kinds for free,
  accessibility features.
- What they'd cost: a heavier runtime (some need a DOM or canvas — awkward in
  the Worker), losing the layer-1/2 postprocessing pipeline the current
  templates share with the raw path, and a look that stops matching the
  vocabulary.
- Cheap version of the experiment: port two kinds to one library, run the bench,
  compare pass rate and rendering weight before committing.

## Smaller ideas, any time

- **Deterministic lint pass before the vision critic**: cheap non-LLM checks on the
  SVG/spec — ticks equidistant? viewBox contains all coordinates? bar height/value
  ratios consistent? Catching these before the Sonnet critique call saves money on
  the expensive model.
- **Enforce text-last layer order in `prepareSvg`** (done, kept — see v2.3):
  instead of trusting the prompt's layering rule, move `<text>` elements to the
  end of the document so labels always win against whatever is under them
  (halos make this fully robust). Implemented as `hoistTextToEnd`.
