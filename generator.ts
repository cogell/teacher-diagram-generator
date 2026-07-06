import { fileURLToPath } from "node:url";
import { Config, Effect, Layer, Schedule, Schema } from "effect";
import { LanguageModel, Response } from "effect/unstable/ai";
import { FetchHttpClient } from "effect/unstable/http";
import {
  OpenRouterClient,
  OpenRouterLanguageModel,
} from "@effect/ai-openrouter";
import { Resvg } from "@resvg/resvg-js";
import visualizationPrinciples from "./docs/visualization-principles.md";
import { ALL_SPEC_KINDS, DiagramSpec, renderSpec, specGuideFor } from "./templates";

const OpenRouterLayer = OpenRouterClient.layerConfig({
  apiKey: Config.redacted("OPENROUTER_API_KEY"),
}).pipe(Layer.provide(FetchHttpClient.layer));

// The drawing model is env-swappable so benchmark sweeps can A/B models
// without code edits. GENERATOR_MODEL takes any OpenRouter id;
// GENERATOR_PROVIDER pins routing to specific providers (comma-separated,
// e.g. "cerebras" — fallbacks off, so a sweep measures the provider it names);
// GENERATOR_REASONING sets reasoning effort for models that think by default
// (reasoning tokens are pure latency/cost on a drawing task this templated);
// GENERATOR_SORT=price|throughput|latency picks among a model's providers
// ("price" reaches the cheapest endpoints, which default load-balancing skips —
// a provider pin alone can still land on that provider's pricier endpoint).
//
// The shipped default is the model-hunt winner (see THINGS_TO_TRY.md):
// gpt-oss-20b, cheapest provider, thinking dialed down — 28+27/30 on the
// bench at ~$0.000085/case, 61x cheaper than the Haiku 4.5 it replaced at
// equal quality (and matching gpt-oss-120b, which the retest showed buys
// nothing this task uses). The reasoning/sort defaults apply only when the
// model is the default too: "low" means thinking OFF-ish for gpt-oss but
// would turn thinking ON for an Anthropic model swapped in via
// GENERATOR_MODEL.
export const GENERATOR_MODEL_ID = process.env.GENERATOR_MODEL || "openai/gpt-oss-20b";
const isDefaultModel = !process.env.GENERATOR_MODEL;
const GENERATOR_PROVIDERS = (process.env.GENERATOR_PROVIDER ?? "")
  .split(",").map((s) => s.trim()).filter(Boolean);
const GENERATOR_REASONING = (process.env.GENERATOR_REASONING || (isDefaultModel ? "low" : undefined)) as
  | "high" | "low" | "medium" | "none" | "xhigh" | "minimal" | undefined;
const GENERATOR_SORT = (process.env.GENERATOR_SORT || (isDefaultModel ? "price" : undefined)) as
  | "price" | "throughput" | "latency" | undefined;

const GeneratorModel = OpenRouterLanguageModel.model(GENERATOR_MODEL_ID, {
  max_tokens: 4000,
  ...(GENERATOR_PROVIDERS.length || GENERATOR_SORT
    ? {
      provider: {
        ...(GENERATOR_PROVIDERS.length ? { only: GENERATOR_PROVIDERS, allow_fallbacks: false } : {}),
        ...(GENERATOR_SORT ? { sort: GENERATOR_SORT } : {}),
      },
    }
    : {}),
  ...(GENERATOR_REASONING ? { reasoning: { effort: GENERATOR_REASONING } } : {}),
}).pipe(Layer.provide(OpenRouterLayer));

/**
 * The shared visual vocabulary, part 1: markers and symbols injected into every
 * SVG by `prepareSvg`, so the model never hand-draws the atoms it botches
 * (arrowheads, open circles, right-angle marks). Sizes assume the ~600-1200
 * unit canvas the prompt asks for. Keep this, `VOCABULARY_CLASS_DEFAULTS`, and
 * `SVG_VOCABULARY_GUIDE` in lockstep — the guide is the model's only
 * documentation of what exists here.
 */
const SVG_VOCABULARY_DEFS =
  `<defs>` +
  // orient="auto", NOT "auto-start-reverse": resvg doesn't support the latter
  // and falls back to a fixed 0° — every arrowhead rendered pointing right no
  // matter the line's direction. With "auto" the head follows the line; the
  // trade-off is that marker-start would point backward INTO the line, so
  // nothing may use marker-start — a double-ended arrow is two lines drawn
  // outward from the middle, each with marker-end (the guide says so too).
  `<marker id="arrow" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="8" markerHeight="8" orient="auto"><path d="M0,0 L10,5 L0,10 z" fill="#333333"/></marker>` +
  // arrow-accent is a retired alias of #arrow (it was blue before the
  // grayscale-first alignment) — kept so SVGs written against older prompts
  // still get an arrowhead instead of a bare line end.
  `<marker id="arrow-accent" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="8" markerHeight="8" orient="auto"><path d="M0,0 L10,5 L0,10 z" fill="#333333"/></marker>` +
  `<g id="dot-filled"><circle r="9" fill="#333333"/></g>` +
  `<g id="dot-empty"><circle r="9" fill="#ffffff" stroke="#333333" stroke-width="1.5"/></g>` +
  `<g id="point-closed"><circle r="7" fill="#333333"/></g>` +
  `<g id="point-open"><circle r="7" fill="#ffffff" stroke="#333333" stroke-width="2.5"/></g>` +
  `<g id="right-angle"><path d="M14,0 L14,-14 L0,-14" fill="none" stroke="#333333" stroke-width="1.5"/></g>` +
  `</defs>`;

/**
 * The shared visual vocabulary, part 2: what each class means. NOT shipped as
 * CSS — a `<style>` rule beats presentation attributes, so CSS classes
 * silently clobbered the model's explicit `fill`/`stroke` (a bar chart asked
 * to use different colors rendered all-white). Instead `prepareSvg` expands
 * each class into these attributes only where the element doesn't already set
 * them: the vocabulary is a default, and the model's own styling always wins.
 *
 * `unshaded` deliberately has NO fill (not white): a white-filled container
 * drawn over existing content blanked out whole diagrams. `outline` is kept as
 * a legacy alias for the same reason — models reach for that word on their own.
 *
 * The palette is grayscale-first, per docs/visualization-principles.md
 * ("light gray vs. black beats red vs. blue") — which the evaluator also
 * judges against, so colored defaults would put the generator and its judge
 * at odds. `shaded` is mid-gray; `shade-1` is a darker gray so single-series
 * charts stay grayscale too; color enters only at `shade-2`+, when categories
 * must be told apart (which several dataset requests explicitly demand).
 */
const VOCABULARY_CLASS_DEFAULTS: Record<string, Record<string, string>> = {
  axis: { stroke: "#333333", "stroke-width": "2", fill: "none" },
  tick: { stroke: "#333333", "stroke-width": "1.5" },
  grid: { stroke: "#dddddd", "stroke-width": "1" },
  label: { "font-size": "16", fill: "#111111" },
  title: { "font-size": "20", "font-weight": "bold", fill: "#111111" },
  shaded: { fill: "#c4c4c4" },
  unshaded: { fill: "none", stroke: "#333333", "stroke-width": "1.5" },
  outline: { fill: "none", stroke: "#333333", "stroke-width": "1.5" },
  "shade-1": { fill: "#8f8f8f" },
  "shade-2": { fill: "#4a90d9" },
  "shade-3": { fill: "#e8973a" },
  "shade-4": { fill: "#5aa469" },
};

/** The prompt-facing documentation of the two vocabulary halves above. */
const SVG_VOCABULARY_GUIDE = `## Shared vocabulary

A standard set of styles and symbols is available in every SVG you produce. Reference them — never redefine them or hand-draw your own versions.

Coordinates: pick spacing that makes your arithmetic trivial — e.g. 100 units per interval on a number line, 40 units per data unit on a bar chart — then size the viewBox to fit the content. Keep the drawing roughly 600-1200 units wide so the sizes below land at a sane scale. The render is cropped to the drawn content automatically, so leftover empty canvas is harmless; exact canvas size does not matter.

Ticks and gridlines: an axis from A to B with ticks every s has (B - A)/s + 1 ticks — one more than the number of intervals. Place them by iterating the VALUES A, A+s, ..., B (position = origin + (value - A) * spacing), never by guessing pixel positions; the last tick must land exactly at B. Every interval is the same pixel length — on a 0-2 number line, the distance from 1 to 2 equals the distance from 0 to 1.

One scale for everything: when the request labels dimensions or values, pick one scale (px per unit) and apply it to EVERY measurement in the drawing. A bar labeled 9 is 9 x unit tall, measured against an axis built from the same unit; legs labeled 6 cm and 8 cm are 6 x unit and 8 x unit long. Never eyeball relative sizes — compute each length from its labeled value.

Classes — put class="..." on elements for the shared look. A class only fills in styling you didn't specify: your own fill/stroke attributes always win, so add attributes only where you mean to differ.
- class="axis" — number lines and chart axes (2px near-black stroke, no fill)
- class="tick" — tick marks
- class="grid" — background gridlines (light gray; context stays muted)
- class="label" — every text label (16px)
- class="title" — chart titles (20px bold)
- class="shaded" — the shading fill (mid-gray) for shaded fraction parts, filled bars, highlighted regions
- class="unshaded" — unshaded parts of fraction/set models (near-black stroke, no fill)
- class="shade-1" through class="shade-4" — categorical fills when multiple bars/series must be told apart. shade-1 is a darker gray, so a single-series chart stays grayscale; color starts at shade-2. When a request explicitly asks for specific colors, honor the request with your own fill attributes.

Borders and containers must use fill="none" (never a white fill) — an opaque shape drawn late covers everything under it.

Text is always near-black. The render automatically puts a white halo behind every label, so dark text stays readable on top of any fill — never use white text or bold for contrast.

Don't label the answer: when the Purpose says students will count, interpret, or find something from the diagram, do not print that answer on it — no count next to a stack of dots they're meant to count, no total on a grid they're meant to tally. Label only what the request asks to be labeled.

Partition models (fraction bars, area models, strips): compute one part size = total / parts, then tile exactly — parts share edges with NO gaps, dividers sit exactly on the shared edges, and the outer border coincides with the tiled area. E.g. 3 equal parts of a 600-wide bar starting at x=60: rects at x=60, 260, 460, each width 200; dividers at x=260 and 460; border from 60 to 660. Grids and arrays work the same way in 2-D: m rows x n columns means exactly m * n cells — cell (row, col) sits at x = originX + col * size, y = originY + row * size. Before finishing, count what you drew: an m x n grid must contain exactly m * n cells, and a group described as N objects must contain exactly N of them.

Arrowheads: put marker-end="url(#arrow)" on the line or path itself — the head follows the line's direction at its end. NEVER use marker-start (it renders backward); for a double-ended arrow, draw two lines outward from the middle, each with marker-end. Never draw arrowhead triangles manually. For a ray or jump arc that must stand out from the axis it sits on, use a thicker near-black stroke, not a color.

Symbols — place with <use href="#id" x="..." y="..."/>, where (x, y) is the symbol's center:
- #dot-filled / #dot-empty — counters for ten-frames, set models, line-plot dots (radius 9)
- #point-closed / #point-open — included/excluded endpoints on number lines, plotted points (radius 7; open = white-filled, for strict inequalities)
- #right-angle — right-angle mark; its legs run from the vertex along +x and up. Rotate for other corners: <use href="#right-angle" x="..." y="..." transform="rotate(a x y)"/>

Layering: draw gridlines first, then shapes, then ALL text last so labels sit on top. The title sits alone in its own band at the top of the drawing — keep every other label clear of it.`;

/**
 * The system instructions that steer the generator. Exported so the evaluator
 * (`evaluator.ts`) can critique the diagram against the very prompt that
 * produced it, and suggest concrete revisions to this exact text.
 */
// The family label each kind goes by in the PREFERRED routing line.
const KIND_FAMILIES: Record<DiagramSpec["kind"], string> = {
  numberLine: "NUMBER LINE",
  barChart: "BAR GRAPH",
  clock: "ANALOG CLOCK",
  coordinatePlane: "COORDINATE PLANE/GRID",
  linePlot: "LINE PLOT",
  fractionBar: "FRACTION BAR/STRIP",
  fractionCircle: "FRACTION CIRCLE",
  tenFrame: "TEN-FRAME",
  dotArray: "DOT/SET ARRAY",
  areaGrid: "AREA MODEL GRID",
  baseTenBlocks: "BASE-TEN BLOCKS",
  shape: "RIGHT TRIANGLE or PARALLELOGRAM",
  rectPrism: "RECTANGULAR PRISM",
};

// The parts every prompt needs: the Visual/Purpose reading rules and the two
// reply shapes, with the DSL manual (all kinds, or a routed subset) between
// them.
const promptHeader = (kinds: readonly DiagramSpec["kind"][]) =>
  `You generate K-12 math diagrams. Reply in exactly ONE of two ways.

Requests arrive as "Visual: ..." plus "Purpose: ...". Draw only the Visual. The Purpose describes the work STUDENTS will do with the diagram — use it to decide what must stay undone (uncounted, unlabeled, unanswered), never as content to draw. Do not solve the Purpose on the diagram: no answer labels, no worked comparisons, no extra panels or captions stating the conclusion. If the Purpose says students will name the fraction, its name appears nowhere; if they will compare two values, no comparison appears.

PREFERRED — diagram spec: if the request is one of these families — ${kinds.map((k) => KIND_FAMILIES[k]).join(", ")} — return ONE JSON object in a \`\`\`json code block matching the schema below, and nothing else. Code renders the spec, so every position, tick, angle, and bar height comes out exactly to scale.

${specGuideFor(kinds)}

FALLBACK — raw SVG: for every other diagram, return ONE self-contained <svg> inside a \`\`\`svg code block, and nothing else.`;

const PROMPT_HEADER = promptHeader(ALL_SPEC_KINDS);

// The default prompt is LEAN: it drops the raw-SVG curriculum — the
// vocabulary guide (~1.5k tokens) and the visualization-principles doc
// (~0.4k) — keeping only a three-line cheat sheet for the fallback path.
// With every dataset case on the spec path those tokens taught a skill the
// model no longer uses, and input tokens are ~95% of generation cost: the
// A/B (see THINGS_TO_TRY.md) held pass rate (29+25 vs 28+26+26 full) while
// cutting cost 35%, with spec adoption still 30/30. An off-DSL request
// under the lean prompt draws plainer-but-valid SVG (the injected
// defs/classes still expand if referenced — the model just isn't taught
// them at length). FULL_PROMPT=1 restores the curriculum for A/Bs.
const LEAN_FALLBACK_NOTE =
  `

For raw SVG: viewBox sized to content, ~600-1200 units wide, black strokes on white, 16px sans-serif labels. These shared classes and symbols exist if useful: class="axis|tick|grid|label|title|shaded|unshaded|shade-1..shade-4", markers/symbols #arrow (marker-end only), #dot-filled, #dot-empty, #point-open, #point-closed, #right-angle (via <use>). Compute every coordinate from one scale; never eyeball positions.`;

export const GENERATOR_SYSTEM_PROMPT = process.env.FULL_PROMPT
  ? `${PROMPT_HEADER}

Follow these visualization principles:

${visualizationPrinciples}

${SVG_VOCABULARY_GUIDE}`
  : PROMPT_HEADER + LEAN_FALLBACK_NOTE;

// Prompt routing (default ON; ROUTED_PROMPT=0 disables): a code-side keyword
// router picks which kinds a request might need, and the prompt carries only
// those kinds' guide sections (~400-800 input tokens instead of ~2.1k).
// Deliberately generous — every matching kind is included, and a request
// that matches nothing gets the full guide — because a missed route costs a
// case while an extra section costs ~100 tokens. The A/B (THINGS_TO_TRY):
// routed gpt-oss-20b held 29+27/30 at half the unrouted cost; routing did
// NOT rescue ling-2.6-flash (SpecInvalid deaths), so the default model stays
// 20b and this flag stays a prompt-size optimization, not a model enabler.
const KIND_ROUTES: [DiagramSpec["kind"], RegExp][] = [
  ["numberLine", /number ?line|inequal|integer|jumps?\b|count(ing)? (forward|back|on)|skip.?count/i],
  ["barChart", /bar (graph|chart)|\bbars\b/i],
  ["clock", /clock|analog|o'? ?clock|:\d{2}\b|minute hand|hour hand/i],
  ["coordinatePlane", /coordinate|quadrant|ordered pair|x-?axis|y-?axis|\(\s*-?\d+\s*,\s*-?\d+\s*\)/i],
  ["linePlot", /line ?plot|dot ?plot|x above|frequency/i],
  ["fractionBar", /strip|tape diagram|fraction bar|bar model|rectangle divided|rectangular bar/i],
  ["fractionCircle", /circle divided|pie|sector|circle .*(parts|shaded)|parts? of a circle/i],
  ["tenFrame", /ten.?frame/i],
  ["dotArray", /dot|circles arranged|set model|array|counters|groups? of (objects|circles)/i],
  ["areaGrid", /area model|unit squares|grid of|rows and columns|column.*row|row.*column/i],
  ["baseTenBlocks", /base.?ten|place.?value|hundred.?flat|ten.?rod|unit.?cube/i],
  ["shape", /triangle|parallelogram|polygon|legs|hypotenuse/i],
  ["rectPrism", /prism|rectangular solid|cuboid/i],
];

export const routeSpecKinds = (request: string): DiagramSpec["kind"][] =>
  KIND_ROUTES.filter(([, re]) => re.test(request)).map(([kind]) => kind);

/** The system prompt for one request: routed subset unless routing is off
 *  (ROUTED_PROMPT=0 / FULL_PROMPT=1) or the router matched nothing. */
const systemPromptFor = (request: string): string => {
  if (process.env.ROUTED_PROMPT === "0" || process.env.FULL_PROMPT) return GENERATOR_SYSTEM_PROMPT;
  const kinds = routeSpecKinds(request);
  if (kinds.length === 0) return GENERATOR_SYSTEM_PROMPT;
  return promptHeader(kinds) + LEAN_FALLBACK_NOTE;
};

// The rewrite pre-pass models, keyed by the REWRITE env value. Sonnet (the
// evaluator's model) exists to do the reading comprehension Haiku fumbles;
// haiku is the cheap variant of the same experiment — is a small model enough
// to sort Visual from Purpose? Text-only either way, so the call is small.
const REWRITER_MODELS = {
  haiku: "anthropic/claude-haiku-4.5",
  sonnet: "anthropic/claude-sonnet-5",
} as const;
export type RewriterKey = keyof typeof REWRITER_MODELS;

/**
 * Resolve the REWRITE env value to a rewriter choice: unset/"none"/"0" → off,
 * "haiku"/"sonnet" → that model, legacy "1" → sonnet (what REWRITE=1 always
 * meant). Exported so the benchmark records the same resolution it ran with.
 */
export const resolveRewriter = (
  value: string | undefined = process.env.REWRITE,
): { key: RewriterKey; modelId: string } | null => {
  if (!value || value === "0" || value === "none") return null;
  const key = value === "1" ? "sonnet" : (value as RewriterKey);
  const modelId = REWRITER_MODELS[key];
  if (!modelId) {
    console.log(`unknown REWRITE value "${value}" — rewrite pre-pass disabled`);
    return null;
  }
  return { key, modelId };
};

const rewriterLayer = (modelId: string) =>
  OpenRouterLanguageModel.model(modelId, { max_tokens: 1000 }).pipe(Layer.provide(OpenRouterLayer));

/**
 * The instructions for the rewrite pre-pass: translate a teacher's raw request
 * into a drawing brief the generator can follow literally. The Visual/Purpose
 * split isn't a clean draw-this/skip-this split — drawing content sometimes
 * hides in the Purpose (d-10's "multiple blank clocks needed for practice"),
 * and answers leak when the Purpose is taken as content (d-15). The brief keeps
 * the "Visual:" shape the generator's system prompt already expects, so raw and
 * rewritten requests flow through the same rules.
 */
export const REWRITER_SYSTEM_PROMPT =
  `You translate a teacher's diagram request into a drawing brief for a smaller model that draws exactly what it is told and infers nothing.

Requests arrive as "Visual: ..." (what to draw) plus "Purpose: ..." (the exercise students will do with the diagram). Reply with a brief in exactly this shape:

Visual: <one self-contained description of everything to draw>
Constraints:
- <things that must NOT appear>

Rules:
- Keep every drawable fact from the Visual: every number, range, count, label, and layout requirement, in the teacher's wording where possible.
- Pull hidden drawing requirements out of the Purpose into the Visual, made concrete (an explicit "multiple blank clocks needed" becomes "draw 4 identical blank clock faces").
- The brief describes exactly ONE diagram unless the request SAYS to draw more than one ("multiple ... needed", "a set of", "several copies"). Students practicing or repeating an activity is NOT a reason to multiply the drawing.
- Turn the students' task into Constraints: the diagram must leave their work undone. "Students count the dots" → "- do NOT print any count or total". "Students name the fraction" → "- do NOT write the fraction anywhere". "Students compare X to Y" → "- do NOT show any comparison".
- The word "Purpose" must not appear in your reply, and nothing from the students' task may be solved, answered, or demonstrated in the brief.
- Output the brief and nothing else.`;

/**
 * The rewrite pre-pass: teacher request in, drawing brief out, via whichever
 * model REWRITE selected. Returns the generation ids it spent — the rewrite
 * sits ON the generation path (unlike the evaluator), so its cost and time
 * belong in the case's rollups. Transient-only retry, mirroring
 * `createDiagram`'s policy.
 */
const rewriteRequest = (request: string, modelId: string) =>
  Effect.gen(function*() {
    const generationIds: string[] = [];
    const reply = yield* LanguageModel.generateText({
      prompt: [
        { role: "system", content: REWRITER_SYSTEM_PROMPT },
        { role: "user", content: request },
      ],
    }).pipe(
      Effect.provide(rewriterLayer(modelId)),
      Effect.retry({
        times: 2,
        schedule: Schedule.exponential("500 millis"),
        while: (error) => error._tag === "AiError" && error.isRetryable,
      }),
    );
    recordGenerationId(reply, generationIds);
    return { brief: reply.text.trim(), generationIds };
  });

/**
 * A generator is `String → Image`: one model call, one render, nothing else on
 * the latency-critical path. Quality control lives in the evaluator
 * (`evaluator.ts`), which the benchmark fires automatically (and in parallel)
 * after each case completes. Returns the `png` bytes plus the OpenRouter
 * `generationIds` (one per model call made, failed attempts included, so the
 * harness can look up real cost — more than one id means retries happened).
 *
 * With `REWRITE=haiku|sonnet` in the environment (legacy `1` = sonnet), a
 * pre-pass on that model first rewrites the teacher's request into an explicit
 * drawing brief (see `REWRITER_SYSTEM_PROMPT`); the brief is what the generator
 * draws from and is returned as `rewrittenRequest` (with `rewriteModel` naming
 * the pre-pass model) so harnesses can persist both. A failed rewrite falls
 * back to the raw request — the pre-pass must never cost us a case.
 *
 * A failed attempt is retried up to twice with exponential backoff, but only
 * for failures a fresh attempt can fix: generation is sampled, so a draft with
 * no <svg> or one resvg can't render is just a bad draw, and the AI library
 * marks which provider errors are transient. Everything else (bad API key,
 * exhausted quota, content policy) fails fast.
 *
 * When every attempt fails, the failure is a `DiagramFailed` carrying the full
 * history — every generation id (they're paid calls) and each attempt's error
 * plus the raw model reply when one was received — so a dead case is
 * diagnosable and billable instead of a bare error name (d-10 once died as
 * `SvgNotFound` with no ids, no drafts, and its spend invisible).
 */
export const createDiagram = (request: string) =>
  Effect.gen(function*() {
    const generationIds: string[] = [];
    const failedAttempts: { error: string; draft: string | null }[] = [];
    // The draft the in-flight attempt received, readable from its tapError.
    // Attempts run sequentially (Effect.retry), so one slot is enough.
    let currentDraft: string | null = null;

    // Optional rewrite pre-pass (REWRITE=haiku|sonnet): rewrite the teacher's
    // request into a drawing brief. Its generation ids join the case's list up
    // front, so even a run where every draw attempt then fails still bills the
    // rewrite.
    let rewrittenRequest: string | null = null;
    let rewriteModel: RewriterKey | null = null;
    const rewriter = resolveRewriter();
    if (rewriter) {
      const rw = yield* Effect.result(rewriteRequest(request, rewriter.modelId));
      if (rw._tag === "Success") {
        rewrittenRequest = rw.success.brief;
        rewriteModel = rewriter.key;
        generationIds.push(...rw.success.generationIds);
      } else {
        console.log(`rewrite failed — drawing from the raw request  ↳ ${String(rw.failure)}`);
      }
    }
    const drawingPrompt = rewrittenRequest ?? request;

    const attempt = Effect.gen(function*() {
      currentDraft = null;
      const draft = yield* LanguageModel.generateText({
        prompt: [
          { role: "system", content: systemPromptFor(drawingPrompt) },
          { role: "user", content: drawingPrompt },
        ],
      }).pipe(Effect.provide(GeneratorModel));
      recordGenerationId(draft, generationIds);
      currentDraft = draft.text;
      const { svg, spec } = yield* extractDiagramSource(draft.text);
      const png = yield* renderPng(svg);
      return { png, svg, spec };
    }).pipe(
      Effect.tapError((error) =>
        Effect.sync(() => failedAttempts.push({ error: String(error), draft: currentDraft }))
      ),
    );

    const { png, svg, spec } = yield* Effect.retry(attempt, {
      times: 2,
      schedule: Schedule.exponential("500 millis"),
      // Our own SVG failures are always worth a fresh draw; provider errors
      // only when the library classifies them as transient.
      while: (error) => error._tag !== "AiError" || error.isRetryable,
    }).pipe(
      Effect.mapError((cause) =>
        new DiagramFailed({ cause, generationIds, attempts: failedAttempts })
      ),
    );

    // `svg` is whatever went into `renderPng` (pre-`prepareSvg`) — the model's
    // raw output on the raw path, the template render on the spec path — and
    // `spec` is the model's JSON when that path was taken. Both are returned so
    // the harness can persist them next to the PNG: regressions get diagnosed
    // from source instead of inferred from pixels. `rewrittenRequest` and
    // `rewriteModel` (null unless the pre-pass ran and succeeded) likewise.
    return { png, svg, spec, generationIds, rewrittenRequest, rewriteModel };
  });

/**
 * The terminal failure of `createDiagram`: all attempts exhausted. Carries the
 * whole story — `cause` is the last attempt's error, `generationIds` every
 * paid model call across attempts (so harnesses can still sum real spend), and
 * `attempts` one entry per failed try with the full raw model reply when the
 * failure happened after a draft came back (`SvgNotFound` alone keeps only a
 * 200-char snippet). Harnesses persist the drafts next to the run artifacts.
 */
export class DiagramFailed extends Schema.TaggedErrorClass<DiagramFailed>()("DiagramFailed", {
  cause: Schema.Unknown,
  generationIds: Schema.Array(Schema.String),
  attempts: Schema.Array(Schema.Struct({
    error: Schema.String,
    draft: Schema.NullOr(Schema.String),
  })),
}) { }

/**
 * Expand vocabulary classes into presentation attributes, attributes-win: for
 * every element carrying a class from `VOCABULARY_CLASS_DEFAULTS`, set the
 * class's attributes ONLY where the element doesn't already set them. We
 * implement the cascade ourselves because CSS has the wrong precedence here —
 * a `<style>` rule beats presentation attributes, so shipping the vocabulary
 * as CSS erased the model's explicit colors. The class attribute itself is
 * left in place (inert without a stylesheet, and useful when reading the
 * prepared SVG).
 */
const expandVocabularyClasses = (svg: string): string =>
  svg.replace(/<[a-zA-Z][^>]*>/g, (tag) => {
    const classAttr = tag.match(/\sclass\s*=\s*(["'])([^"']*)\1/i);
    if (!classAttr) return tag;
    const defaults: Record<string, string> = {};
    for (const name of classAttr[2]!.trim().split(/\s+/)) {
      Object.assign(defaults, VOCABULARY_CLASS_DEFAULTS[name]);
    }
    let added = "";
    for (const [attr, value] of Object.entries(defaults)) {
      // `fill\s*=` can't false-match `fill-opacity=` (the "-" breaks the `=`).
      if (!new RegExp(`[\\s"']${attr}\\s*=`, "i").test(tag)) added += ` ${attr}="${value}"`;
    }
    if (!added) return tag;
    return tag.endsWith("/>") ? `${tag.slice(0, -2)}${added}/>` : `${tag.slice(0, -1)}${added}>`;
  });

/**
 * Normalize white-ish text to near-black. Models reach for white text to get
 * contrast on shaded fills, but the injected halo already guarantees dark text
 * is readable on any fill — and white glyphs merge with the white halo into
 * fattened blobs (and would vanish entirely on the white page background).
 */
const normalizeTextFills = (svg: string): string =>
  svg.replace(/<(?:text|tspan)\b[^>]*>/gi, (tag) =>
    /\sfill\s*=\s*(["'])(?:#fff(?:fff)?|white)\1/i.test(tag)
      ? tag.replace(/\sfill\s*=\s*(["'])[^"']*\1/i, ` fill="#111111"`)
      : tag,
  );

/**
 * Rescue elements that would render invisible: a <line> with no stroke, or a
 * <path>/<polyline> with fill="none" and no stroke, draws nothing at all —
 * which is what happens when the model styles via an invented class that
 * doesn't exist (d-03's fraction-bar dividers vanished this way). Runs after
 * class expansion, so anything still strokeless here has no styling at all;
 * better visible-but-plain than silently missing. Skipped entirely when the
 * model styles via group-level inheritance, which this tag-local check can't
 * see through.
 */
const fixInvisibleStrokes = (svg: string): string => {
  if (/<g[^>]*\s(?:stroke|style)\s*=/i.test(svg)) return svg;
  return svg.replace(/<(line|polyline|path)\b[^>]*>/gi, (tag, name: string) => {
    if (/[\s"'](?:stroke|style)\s*=/i.test(tag)) return tag;
    const invisible = name.toLowerCase() === "line" || /\sfill\s*=\s*(["'])none\1/i.test(tag);
    if (!invisible) return tag;
    const insert = ` stroke="#333333" stroke-width="1.5"`;
    return tag.endsWith("/>") ? `${tag.slice(0, -2)}${insert}/>` : `${tag.slice(0, -1)}${insert}>`;
  });
};

/**
 * Move every rendered <text> element to the end of the document, so labels
 * paint on top of whatever the model drew after them — the prompt's layering
 * rule ("all text last"), enforced instead of trusted. Combined with the
 * injected halo this makes label-over-line collisions structurally impossible
 * (d-28's clock ticks pierced its numerals this way). Ancestry is preserved:
 * a text inside <g> wrappers is re-wrapped in copies of those exact <g> tags,
 * so inherited transforms, fills, and fonts survive the move (transform
 * composition order is kept by nesting in the same order). Texts that can't
 * be moved safely stay put: anything inside non-rendered containers
 * (defs/symbol/marker/clipPath/mask/pattern) or inside containers other than
 * <g> (nested <svg> establishes its own coordinate system, <a>, <switch>...).
 */
const hoistTextToEnd = (svg: string): string => {
  const lower = svg.toLowerCase();
  const tagRe = /<!--[\s\S]*?-->|<\/?[a-zA-Z][^>]*>/g;
  const NON_RENDER = new Set(["defs", "symbol", "marker", "clippath", "mask", "pattern"]);
  const stack: { name: string; tag: string }[] = [];
  const hoisted: string[] = [];
  let kept = "";
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = tagRe.exec(svg))) {
    const tag = m[0]!;
    if (tag.startsWith("<!--")) continue;
    const name = tag.match(/^<\/?([a-zA-Z][\w:-]*)/)![1]!.toLowerCase();
    if (tag.startsWith("</")) {
      const i = stack.findLastIndex((s) => s.name === name);
      if (i >= 0) stack.length = i;
      continue;
    }
    if (tag.endsWith("/>")) continue;
    if (name !== "text") {
      stack.push({ name, tag });
      continue;
    }
    const movable = !stack.some((s, i) =>
      NON_RENDER.has(s.name) || !(s.name === "g" || (s.name === "svg" && i === 0))
    );
    const close = lower.indexOf("</text>", tagRe.lastIndex);
    if (!movable || close === -1) {
      stack.push({ name, tag });
      continue;
    }
    const end = close + "</text>".length;
    const wrappers = stack.filter((s) => s.name === "g" && /\s[a-zA-Z]/.test(s.tag));
    hoisted.push(
      wrappers.map((g) => g.tag).join("")
      + svg.slice(m.index, end)
      + "</g>".repeat(wrappers.length),
    );
    kept += svg.slice(last, m.index);
    last = end;
    tagRe.lastIndex = end;
  }
  if (hoisted.length === 0) return svg;
  kept += svg.slice(last);
  return kept.replace(/<\/svg>\s*$/i, `${hoisted.join("")}</svg>`);
};

/**
 * Deterministic cleanup applied to every model-drawn SVG before rasterizing,
 * so the fixes hold even when the model ignores its instructions:
 *
 * - Pad the viewBox ~5% on every side as a fallback against edge-clipping
 *   (`renderPng` then crops to the real content bounding box anyway).
 * - Expand vocabulary classes into presentation attributes, attributes-win
 *   (see `expandVocabularyClasses`).
 * - Normalize white text to near-black (see `normalizeTextFills`).
 * - Give otherwise-invisible strokeless lines a default stroke
 *   (see `fixInvisibleStrokes`).
 * - Move rendered text to the end of the document so labels always paint on
 *   top (see `hoistTextToEnd`).
 * - Inject the shared symbols (`SVG_VOCABULARY_DEFS`) right after the opening
 *   tag, so the ids the prompt tells the model to reference actually exist —
 *   and, being first in the document, win over duplicate ids the model
 *   defined anyway.
 * - Give every <text> a white halo (`paint-order: stroke` paints the outline
 *   *under* the glyph fill), so labels stay readable on top of lines/shading.
 * - Normalize to sans-serif so output doesn't depend on the model's font pick.
 *
 * The halo width scales with the viewBox, since font sizes do too. Exported so
 * it can be exercised directly on a saved SVG.
 */
export const prepareSvg = (svg: string): string => {
  let out = svg;
  let box: { minX: number; minY: number; width: number; height: number } | null = null;

  const viewBoxAttr = out.match(/viewBox\s*=\s*(["'])([^"']+)\1/i);
  if (viewBoxAttr) {
    const nums = viewBoxAttr[2]!.trim().split(/[\s,]+/).map(Number);
    if (nums.length === 4 && nums.every(Number.isFinite) && nums[2]! > 0 && nums[3]! > 0) {
      box = { minX: nums[0]!, minY: nums[1]!, width: nums[2]!, height: nums[3]! };
    }
  } else {
    // No viewBox: synthesize one from width/height so we can still pad.
    const dim = (name: string) => {
      const m = out.match(new RegExp(`<svg[^>]*\\s${name}\\s*=\\s*(["'])([0-9.]+)(?:px)?\\1`, "i"));
      return m ? Number(m[2]) : NaN;
    };
    const width = dim("width");
    const height = dim("height");
    if (Number.isFinite(width) && Number.isFinite(height) && width > 0 && height > 0) {
      box = { minX: 0, minY: 0, width, height };
    }
  }

  if (box) {
    const padX = box.width * 0.05;
    const padY = box.height * 0.05;
    const padded = `viewBox="${box.minX - padX} ${box.minY - padY} ${box.width + 2 * padX} ${box.height + 2 * padY}"`;
    out = viewBoxAttr
      ? out.replace(viewBoxAttr[0], padded)
      : out.replace(/<svg/i, `<svg ${padded}`);
  }

  out = expandVocabularyClasses(out);
  out = normalizeTextFills(out);
  out = fixInvisibleStrokes(out);
  out = hoistTextToEnd(out);
  out = out.replace(/<svg[^>]*>/i, (openingTag) => openingTag + SVG_VOCABULARY_DEFS);

  // Injected last so it wins the cascade against any <style> the model wrote.
  const haloWidth = box ? Math.max(box.width, box.height) * 0.005 : 3.5;
  const style =
    `<style>text{paint-order:stroke;stroke:#ffffff;stroke-width:${haloWidth.toFixed(2)}px;` +
    `stroke-linejoin:round;stroke-linecap:round;font-family:sans-serif}</style>`;
  return out.replace(/<\/svg>\s*$/i, `${style}</svg>`);
};

// font (local only): every `new Resvg()` rebuilds its font database, and
// letting it scan the system fonts costs ~355ms of the ~360ms per render
// (measured; two instances per case = ~21s of blocked event loop across a
// 30-case run). Loading only the bundled DejaVu files takes ~3ms — the same
// font the Worker deploy renders with, so local and deployed PNGs match.
// prepareSvg already normalizes every font-family to sans-serif, which maps
// to DejaVu via sansSerifFamily. Guarded on Bun because on Workers this file
// renders through the wasm shim (see worker/resvg-shim.ts), which injects
// bundled font *buffers* itself — a caller-supplied `font` block with
// filesystem paths would override it and break text.
const LOCAL_FONT_OPTIONS = typeof Bun === "undefined" ? undefined : {
  loadSystemFonts: false,
  fontFiles: [
    fileURLToPath(new URL("./worker/fonts/DejaVuSans.ttf", import.meta.url)),
    fileURLToPath(new URL("./worker/fonts/DejaVuSans-Bold.ttf", import.meta.url)),
  ],
  defaultFontFamily: "DejaVu Sans",
  sansSerifFamily: "DejaVu Sans",
};

const RENDER_OPTIONS = {
  background: "white",
  fitTo: { mode: "width", value: 720 },
  ...(LOCAL_FONT_OPTIONS ? { font: LOCAL_FONT_OPTIONS } : {}),
} as const;

/** Raised when resvg cannot parse/render the model's SVG. */
class SvgUnrenderable extends Schema.TaggedErrorClass<SvgUnrenderable>()(
  "SvgUnrenderable",
  { cause: Schema.Unknown },
) { }

/**
 * Rasterize an SVG (after deterministic cleanup) to PNG bytes. Rendered twice:
 * a probe pass computes the bounding box of everything actually drawn, then
 * the real pass renders with the viewBox cropped to that box plus a margin.
 * This kills dead canvas space AND makes the model's canvas-size choice
 * irrelevant — content outside the declared viewBox comes back into frame
 * instead of clipping. The margin also covers bits the bbox may under-report
 * (marker arrowheads, text halos). Falls back to the prepared SVG as-is when
 * no bbox is computable (e.g. nothing visible drawn).
 */
const renderPng = (svg: string) =>
  Effect.try({
    catch: (cause) => new SvgUnrenderable({ cause }),
    try: () => {
      const prepared = prepareSvg(svg);
      const bbox = new Resvg(prepared, RENDER_OPTIONS).getBBox();
      let final = prepared;
      if (bbox && bbox.width > 0 && bbox.height > 0) {
        const margin = Math.max(16, Math.max(bbox.width, bbox.height) * 0.04);
        const cropped = `viewBox="${bbox.x - margin} ${bbox.y - margin} ${bbox.width + 2 * margin} ${bbox.height + 2 * margin}"`;
        // Rewrite only the root element's viewBox — the injected <marker>s carry
        // viewBox attributes of their own that a document-wide replace could hit.
        final = prepared.replace(/<svg[^>]*>/i, (openingTag) =>
          /viewBox\s*=/i.test(openingTag)
            ? openingTag.replace(/viewBox\s*=\s*(["'])[^"']*\1/i, cropped)
            : openingTag.replace(/<svg/i, `<svg ${cropped}`),
        );
      }
      return new Resvg(final, RENDER_OPTIONS).render().asPng();
    },
  });

// We store OpenRouter's generation ids for post-facto analytics (cost,
// latency, etc.) — one per model call, so the harness can sum real spend.
const recordGenerationId = (
  generation: { readonly content: ReadonlyArray<{ type: string }> },
  ids: string[],
) => {
  const meta = generation.content.find(
    (p): p is Response.ResponseMetadataPart => p.type === "response-metadata",
  );
  if (meta?.id) ids.push(meta.id);
};

/** Raised when the model's reply contains no <svg> element (and no spec). */
class SvgNotFound extends Schema.TaggedErrorClass<SvgNotFound>()("SvgNotFound", {
  output: Schema.String,
}) { }

/** Raised when the reply contained JSON but it isn't a renderable spec —
 *  unparseable, wrong shape, an invented kind, or degenerate values. A bad
 *  spec is just a bad draw, so this retries like `SvgNotFound` does. */
class SpecInvalid extends Schema.TaggedErrorClass<SpecInvalid>()("SpecInvalid", {
  issue: Schema.String,
  output: Schema.String,
}) { }

const decodeSpec = Schema.decodeUnknownEffect(DiagramSpec);

/** Parse + validate + render a spec candidate; every failure is `SpecInvalid`. */
const renderSpecSource = (json: string) =>
  Effect.gen(function*() {
    const fail = (issue: unknown) =>
      new SpecInvalid({ issue: String(issue), output: json.slice(0, 200) });
    const parsed = yield* Effect.try({
      try: () => JSON.parse(json) as unknown,
      catch: fail,
    });
    const spec = yield* decodeSpec(parsed).pipe(Effect.mapError(fail));
    // renderSpec is nearly total, but degenerate values the schema can't
    // express (e.g. max <= min) throw — that's a bad spec too.
    const svg = yield* Effect.try({ try: () => renderSpec(spec), catch: fail });
    return { svg, spec };
  });

/**
 * Pulls the diagram source out of the model's reply: a ```json spec block
 * (rendered through `renderSpec`), or a raw <svg>…</svg> as the fallback.
 * A found-but-broken spec does NOT fall through to the svg path — it fails as
 * `SpecInvalid` so the retry gets a fresh draw instead of whatever stray
 * markup happened to be in the same reply.
 */
const extractDiagramSource = (
  text: string,
): Effect.Effect<{ svg: string; spec?: DiagramSpec }, SvgNotFound | SpecInvalid> => {
  const fenced = text.match(/```json\s*([\s\S]*?)```/i);
  if (fenced?.[1]) return renderSpecSource(fenced[1]);

  const svg = text.match(/<svg[\s\S]*?<\/svg>/i);
  if (svg?.[0]) return Effect.succeed({ svg: svg[0] });

  // No fence, no svg: a bare JSON object is the last plausible shape (models
  // sometimes drop the fence), mirroring how parseEvaluation grabs `{…}` —
  // but only when the slice mentions "kind", or any stray braces (a truncated
  // SVG's CSS block, say) would masquerade as a spec and muddy the diagnosis.
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start !== -1 && end > start) {
    const candidate = text.slice(start, end + 1);
    if (candidate.includes(`"kind"`)) return renderSpecSource(candidate);
  }

  return Effect.fail(new SvgNotFound({ output: text.slice(0, 200) }));
};
