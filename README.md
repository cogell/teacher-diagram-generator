# Diagram Generator

The task and how it's evaluated live in the brief you came from. This README is just how to
run the scaffold and how it's wired.

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

- **`explore.ts`** — a small local viewer. Pick a run from the dropdown to see every diagram
  with its latency and cost, and compare runs as you iterate. There's no automated judge; it
  just shows outputs.

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
