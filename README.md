# Diagram Generator

The task and how it's evaluated live in the brief you came from. This README covers where
the work ended up, how to run the scaffold, and how it's wired. The full experiment log —
every idea tried, parked, or pending, with run-by-run evidence — is in
[THINGS_TO_TRY.md](./THINGS_TO_TRY.md).

## Where this ended up

> "Give me six hours to chop down a tree and I will spend the first four sharpening the axe."

Most of the time went into the axe: the explorer grew from a passive run viewer into the
experiment harness everything else was measured with. Then the generator was improved in
deterministic layers, each one validated (or killed) by a benchmark run.

### Explorer improvements

- Fire off benchmark runs from the header, with a case limit (1–all).
- Benchmark cases run concurrently instead of sequentially.
- Average $ per case in the run summary.
- Each card shows the model's verbatim output *before* our SVG layers touch it
  (JSON spec, raw SVG, or failed-attempt replies).
- An experiment journal per run: a hypothesis is **required** to start a run, and a
  free-text finding is recorded after — both surfaced in the history view.
- An LLM-as-judge evaluator (vision model) fires automatically per case — this gave us a
  quality metric to climb against:
  - reports pass/fail, a 0–5 grade, and a critique. The critique was often the only way to
    see what the judge was thinking and fix its prompt.
  - humans can override the pass/fail call and the grade, and add qualitative notes per
    case (the overrides got real use; the notes less so).
  - the judge is now saturating — see the evaluator entries in THINGS_TO_TRY.md.
- A `/history` page listing every run: cases, latency, cost/case, pass rate, quality.
- A cost-vs-pass-rate scatter over full runs, dot size = p50 latency, so the Pareto
  frontier reads by eye.

### What improved quality (at little to no latency or cost)

- **Visual principles in the system prompt** — distilled from Edward Tufte into
  `docs/visualization-principles.md`; the same doc is what the judge scores against, so
  generator and evaluator pull in one direction.
- **Retry ×2 with backoff** on failures a fresh attempt can fix — "no image at all" is
  worse than "mediocre image".
- **Deterministic SVG post-processing**: normalize fonts; hoist text to paint last with a
  white halo so labels always read; auto-crop to the drawn content (the model often gets
  the viewBox wrong and clips its own drawing — this makes clipping structurally
  impossible).
- **Injected SVG defs + classes**: our own arrowheads (with correct orientation), axis /
  tick / grid / label, shaded / unshaded, and a grayscale-first palette — higher fidelity
  and cohesion, less cognitive load on the model.
- **A drawing DSL with raw fallback**: drawing in SVG is hard for a *language* model — it
  does coordinate arithmetic in its head and gets it wrong. Easier to give it a
  declarative way to say what to draw (the same idea behind HTML): the model emits a
  small JSON spec (`numberLine`, `barChart`, `clock`, `coordinatePlane`, `linePlot`,
  `fractionBar`, `fractionCircle`) and code computes the geometry. Requests the DSL
  doesn't cover fall back to raw SVG, so coverage gaps degrade instead of failing.

### Tried and put aside (details + evidence in THINGS_TO_TRY.md)

- Generate → critique → re-generate loop (too slow on the generation path; the value
  moved into the off-path evaluator).
- Sonnet as a better drawer (it makes the same in-head-geometry mistakes).
- HTML instead of SVG (SVG's explicit coordinate space suits these diagrams better).
- Few-shot SVG exemplars (no exemplar pool good enough to teach from materialized).

### Current issues

- **d-10** — the request's Purpose asks for *multiple* blank clocks; we draw one.
- **d-16** — consistently low quality; if this is a common ask, a few-shot system-prompt
  update may be warranted.
- **d-24** — regularly rendered too small to be useful in a printout.
- **d-29** — so close; bars sometimes come out the wrong height.
- **d-30** — so close; side labels sometimes swap.

### Next steps

- Attack the current issues above.
- The evaluator is saturating — improve it (per-request rubrics, calibration anchors).
- Expand the dataset from 30 to ~100 cases; grow the DSL alongside it.
- Evaluate the DSL against open-source diagram libraries.
- Smart routing: when a request can't use the DSL, route it to a stronger model — and
  flag the instance as a signal for which template to build next.
- Tidy up the repo.

## Setup

```sh
bun install
cp .env.example .env     # paste the OpenRouter key from the email
bun run bench            # generate every case → runs/<timestamp>/
bun run explore          # browse runs at http://localhost:8000
```

## How it's wired

- **`generator.ts`** — `createDiagram(request: string)` → `{ png, generationId }`. **This is
  the part you improve.** A generator is `String → Image` (PNG bytes). The naive one asks a
  model for an SVG and rasterizes it, but the SVG is an implementation detail — produce the
  raster however you like. Return the `png` bytes plus the OpenRouter `generationId` (if you
  have one) so the harness can look up real cost. The default model is set at the top of this
  file. 

- **`benchmark.ts`** — Use this to evaluate your pipeline. It reads our dataset `dataset.jsonl`, runs `createDiagram` over every
  case, times it, and writes a run to `runs/<timestamp>/` (one `<case>.png` plus a `run.json`
  manifest). Per-diagram cost is looked up from OpenRouter *after* the run — its `/generation`
  endpoint indexes a few seconds late — so costs fill in at the end.

- **`explore.ts`** — the local explorer (see "Explorer improvements" above): browse runs,
  fire benches, rerun single cases, judge/override/annotate, and compare runs on the
  `/history` page. The judge itself lives in **`evaluator.ts`**; the shared route/storage
  logic and HTML are in **`core.ts`** / **`ui.ts`**.

- **`dataset.jsonl`** — 30 requests, one JSON object per line:
  `{ "id": "d-01", "request": "Visual: … Purpose: …" }`.

## Deployed explorer (Cloudflare Workers)

The full explorer also runs on a Cloudflare Worker, password-gated, with runs stored
in R2 instead of `runs/`:

- **URL**: https://coteach-diagram-explorer.cogell.workers.dev (password required)
- **`core.ts` / `ui.ts`** — the explorer's routes/logic and HTML, shared verbatim between
  the local Bun server (`explore.ts`) and the Worker (`worker/index.ts`).
- **`worker/`** — the Worker entry (cookie auth gate + R2-backed store), the
  `waitUntil`-based bench runner, and a wasm shim that stands in for the native
  `@resvg/resvg-js` (wrangler aliases the package; DejaVu Sans is bundled because
  Workers have no system fonts).

```sh
wrangler r2 bucket create coteach-diagram-explorer-runs
wrangler deploy
wrangler secret put OPENROUTER_API_KEY     # same key as .env
wrangler secret put SITE_PASSWORD          # the shared password for the site
bun scripts/seed-runs.ts https://<worker-host>   # copy local runs/ into R2
```

Local dev: put both vars in `.dev.vars` and `wrangler dev`.

**Known limit (deliberate, for now):** benches run inside `ctx.waitUntil`, which the
runtime only keeps alive ~30s after the response. Single-case reruns and small
limits (the default 6) fit; a full 30-case bench will be cut off part-way — every
completed case is already flushed to R2, so what remains is a valid partial run,
and the status bar reports the stall. The clean fix is a Durable Object with an
alarm loop; noted as next step.
