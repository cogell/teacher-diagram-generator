# Things to Try

The shared-SVG-library plan, as layers: 1 and 2 are implemented in `generator.ts`;
3 and 4 are future, in the order we'd try them — though layer 4 is expected to
matter more than layer 3. After the layers: other things tried, and smaller ideas.

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
  can't inherit line color.
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

## Layer 4: Parameterized templates / DSL — where the scale bugs die

Layers 1–3 don't fix the most damning failure class the critic checks for:
out-of-scale drawings (a bar labeled 9 ending at 8.5, uneven tick spacing). Those
come from the LLM doing coordinate arithmetic in its head. The fix is having code
compute positions: the model emits a small JSON spec, deterministic TypeScript
renders it to SVG.

```jsonc
{ "kind": "numberLine", "min": 0, "max": 10, "tickEvery": 1, "labelEvery": 1,
  "marks": [{ "at": 3, "style": "openCircle" }],
  "shade": { "from": 3, "to": 10, "arrow": true } }
```

- **Template functions** (~9 cover the whole dataset, each 30–60 lines):
  `numberLine`, `fractionBar`, `fractionCircle`, `barChart` (also covers line
  plots), `grid` (coordinate plane), `arrayModel` (ten-frames, set models, dot
  arrays), `baseTenBlocks`, `clock`, plus geometry helpers (labeled edges,
  right-angle marks, dashed hidden edges).
- **Why it works**: tick spacing, bar heights, sector angles, and clock-hand angles
  become provably correct. The clock is the poster child — "hour hand just past 3"
  at 3:15 is a precise 97.5° that code gets right and models don't. Haiku's job
  shrinks to understanding the request (which it's good at) and away from geometry
  (which it isn't).
- **Escape hatch**: keep raw SVG available so out-of-taxonomy requests still work —
  `{ "kind": "rawSvg", "svg": "..." }` in the spec schema, and let composite
  requests mix template output with raw overlay elements (e.g. d-05's
  parallelogram-with-diagonal). Templates should emit the layer-2 vocabulary so
  everything shares one look.
- **Where to start**: number lines and bar graphs — the two families where scale
  errors are most likely and most visible (11 of the 30 dataset requests). Expand
  only if evaluator scores justify it.
- **Validate specs with `Schema`** (already a dependency) so a malformed spec fails
  loudly and can be retried, mirroring how `parseCritique` handles sloppy model JSON.

## Few-shot request → great-output pairs in the prompt

Put real (request, SVG) pairs in `GENERATOR_SYSTEM_PROMPT`: an actual dataset
request followed by a great SVG we generated for it. Kin to layer 3, but instead
of hand-authored skeletons, harvest winners — the explorer already highlights best
runs, and both harnesses now persist the raw model SVG per case, so top-rated runs
are a ready-made exemplar pool.

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

## Smaller ideas, any time

- **Deterministic lint pass before the vision critic**: cheap non-LLM checks on the
  SVG/spec — ticks equidistant? viewBox contains all coordinates? bar height/value
  ratios consistent? Catching these before the Sonnet critique call saves money on
  the expensive model.
- **Enforce text-last layer order in `prepareSvg`** (done, kept — see v2.3):
  instead of trusting the prompt's layering rule, move `<text>` elements to the
  end of the document so labels always win against whatever is under them
  (halos make this fully robust). Implemented as `hoistTextToEnd`.
