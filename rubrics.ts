/**
 * Per-request rubrics for the judge — the fix for the noisy ruler. Each dataset
 * request gets a one-time, cached, human-editable checklist: atomic facts the
 * judge verifies by looking at the image, plus forbidden items (answer leaks)
 * that must be absent. The evaluator then checks facts instead of ruling
 * holistically — fact-level pass/fail is far lower variance than a 0-5 gestalt,
 * and a score change across runs becomes "which fact flipped".
 *
 * `rubrics.jsonl` lives next to `dataset.jsonl` and is committed. Derivation
 * (`bun rubrics.ts`, or `pnpm rubrics`) only fills entries that are missing or
 * whose `requestHash` no longer matches the dataset — a matching hash is never
 * rewritten, so hand-edits to `ruling`/`facts`/`forbidden` are durable. The
 * `ruling` field pins the interpretation of ambiguous or self-contradictory
 * requests ONCE (d-25's "5-foot strip in 3 sections of 1/3 ft" flipped verdicts
 * for opposite reasons across runs); the LLM drafts it, a human ratifies it.
 *
 *   bun rubrics.ts              # derive missing/stale entries
 *   FORCE=d-25 bun rubrics.ts   # re-derive one id (then re-review it)
 */
import { Config, Effect, Layer, Schedule, Schema } from "effect";
import { LanguageModel } from "effect/unstable/ai";
import { FetchHttpClient } from "effect/unstable/http";
import {
  OpenRouterClient,
  OpenRouterLanguageModel,
} from "@effect/ai-openrouter";

export const Rubric = Schema.Struct({
  id: Schema.String,
  /** First 12 hex chars of sha256(request) — a stale hash means the dataset
   *  request changed and this rubric no longer describes it. */
  requestHash: Schema.String,
  /** The pinned interpretation of an ambiguous/contradictory request. The
   *  judge is told this is settled and must not re-litigate it. */
  ruling: Schema.optionalKey(Schema.String),
  /** Atomic statements verifiable from the image alone. */
  facts: Schema.Array(Schema.String),
  /** What must NOT appear — mostly the students' task pre-answered. */
  forbidden: Schema.Array(Schema.String),
});
export type Rubric = typeof Rubric.Type;

export const hashRequest = (request: string): string => {
  const hasher = new Bun.CryptoHasher("sha256");
  hasher.update(request);
  return hasher.digest("hex").slice(0, 12);
};

const rubricsUrl = new URL("./rubrics.jsonl", import.meta.url);
const datasetUrl = new URL("./dataset.jsonl", import.meta.url);

const parseJsonl = <T>(text: string): T[] =>
  text.trim().split("\n").filter(Boolean).map((l) => JSON.parse(l) as T);

/**
 * The rubrics the harnesses hand to the evaluator, keyed by case id. Entries
 * whose hash no longer matches the dataset are omitted WITH A WARNING — a
 * stale-rubric case falls back to the holistic judge instead of being judged
 * against facts about a request that no longer exists.
 */
export const loadRubrics = (): Effect.Effect<Map<string, Rubric>> =>
  Effect.promise(async () => {
    // RUBRICS=0 disables rubric judging entirely (holistic fallback) — the
    // clean A/B switch, running identical code with an empty map.
    if (process.env.RUBRICS === "0") return new Map<string, Rubric>();
    const file = Bun.file(rubricsUrl);
    if (!(await file.exists())) return new Map<string, Rubric>();
    const requests = new Map(
      parseJsonl<{ id: string; request: string }>(await Bun.file(datasetUrl).text())
        .map((d) => [d.id, d.request]),
    );
    const out = new Map<string, Rubric>();
    for (const raw of parseJsonl<unknown>(await file.text())) {
      const rubric = Schema.decodeUnknownSync(Rubric)(raw);
      const request = requests.get(rubric.id);
      if (request === undefined) continue; // rubric for a removed case
      if (hashRequest(request) !== rubric.requestHash) {
        console.warn(
          `rubrics: ${rubric.id} is STALE (request changed) — falling back to holistic judging; run \`bun rubrics.ts\``,
        );
        continue;
      }
      out.set(rubric.id, rubric);
    }
    return out;
  });

// ---------------------------------------------------------------------------
// Derivation — everything below only runs from `bun rubrics.ts`.
// ---------------------------------------------------------------------------

const OpenRouterLayer = OpenRouterClient.layerConfig({
  apiKey: Config.redacted("OPENROUTER_API_KEY"),
}).pipe(Layer.provide(FetchHttpClient.layer));

// Sonnet, text-only: rubric derivation is reading comprehension, the same job
// the evaluator and the REWRITE pre-pass trust it with.
const DeriverModel = OpenRouterLanguageModel.model("anthropic/claude-sonnet-5", {
  max_tokens: 4000,
}).pipe(Layer.provide(OpenRouterLayer));

/** What the derivation model returns — code adds `id`/`requestHash`. */
const DerivedRubric = Schema.Struct({
  ruling: Schema.optionalKey(Schema.String),
  facts: Schema.Array(Schema.String),
  forbidden: Schema.Array(Schema.String),
});

const DERIVER_SYSTEM_PROMPT =
  `You convert a teacher's diagram request into a verification rubric for a vision-model judge that will look ONLY at a rendered image of the diagram.

Requests arrive as "Visual: ..." (what to draw) plus "Purpose: ..." (the exercise students will do with the diagram). Reply with a single JSON object, no markdown fences, with exactly these keys:
- "facts": string[] — 4-8 atomic statements, each verifiable by looking at the image alone
- "forbidden": string[] — things that must NOT appear in the image
- "ruling": string — ONLY when the request is ambiguous or self-contradictory (omit the key otherwise)

Rules for facts:
- One assertion per fact. Cover: element counts, exact label text, diagram type and orientation ("three vertical bars"), positions, and relative sizes.
- When a fact involves a magnitude, embed the verification method and a tolerance: "the bar labeled 9 ends at the 9 gridline, not visibly above or below it" — never a bare "the bar is 9 tall".
- Facts must be checkable as true/false from pixels. No style, color taste, or overall-quality judgments.
- Do NOT include a generic legibility fact (text readable, nothing clipped) — the judge adds a standard one itself.

Rules for forbidden:
- The Purpose describes what STUDENTS will produce — whatever they are asked to count, name, compare, or compute must be ABSENT from the image. "Students count how many 1/4-foot pieces fit" → forbid any printed count or division result.
- Also include anything the Visual explicitly excludes ("no hands drawn", "the hypotenuse is left unlabeled").

Rule for ruling:
- If the request contradicts itself or supports two readings (e.g. a 5-foot strip "divided into 3 equal sections each labeled 1/3 foot" — 3 x 1/3 ft = 1 ft, not 5 ft), do NOT average the readings. State the contradiction, pick the most instructionally sensible interpretation OR explicitly accept both, and write the facts so the judge never has to re-litigate the ambiguity (e.g. drop the section count from the facts entirely and forbid only the printed answer).`;

const deriveRubric = (request: string) =>
  Effect.gen(function*() {
    const reply = yield* LanguageModel.generateText({
      prompt: [
        { role: "system", content: DERIVER_SYSTEM_PROMPT },
        { role: "user", content: request },
      ],
    }).pipe(
      Effect.provide(DeriverModel),
      Effect.retry({
        times: 2,
        schedule: Schedule.exponential("500 millis"),
        while: (error) => error._tag === "AiError" && error.isRetryable,
      }),
    );
    // Grab the outermost {…} — same tolerance for fences/prose as the judge's
    // parseEvaluation.
    const start = reply.text.indexOf("{");
    const end = reply.text.lastIndexOf("}");
    if (start === -1 || end <= start) {
      return yield* Effect.fail(new Error(`no JSON in derivation reply: ${reply.text.slice(0, 200)}`));
    }
    const json = JSON.parse(reply.text.slice(start, end + 1)) as unknown;
    return yield* Schema.decodeUnknownEffect(DerivedRubric)(json);
  });

const main = Effect.gen(function*() {
  const dataset = parseJsonl<{ id: string; request: string }>(
    yield* Effect.promise(() => Bun.file(datasetUrl).text()),
  );
  const existing = new Map<string, Rubric>();
  const file = Bun.file(rubricsUrl);
  if (yield* Effect.promise(() => file.exists())) {
    for (const raw of parseJsonl<unknown>(yield* Effect.promise(() => file.text()))) {
      const r = Schema.decodeUnknownSync(Rubric)(raw);
      existing.set(r.id, r);
    }
  }

  const force = new Set((process.env.FORCE ?? "").split(",").filter(Boolean));
  const todo = dataset.filter((d) => {
    if (force.has(d.id)) return true;
    const have = existing.get(d.id);
    return !have || have.requestHash !== hashRequest(d.request);
  });
  console.log(`${dataset.length} cases · ${existing.size} rubrics on file · deriving ${todo.length}`);

  yield* Effect.forEach(
    todo,
    (d) =>
      Effect.gen(function*() {
        const derived = yield* deriveRubric(d.request);
        existing.set(d.id, { id: d.id, requestHash: hashRequest(d.request), ...derived });
        console.log(`${d.id}  ${derived.facts.length} facts · ${derived.forbidden.length} forbidden${"ruling" in derived && derived.ruling ? " · RULING (review me)" : ""}`);
      }),
    { concurrency: 6, discard: true },
  );

  // Stable output: dataset order, one JSON line per case, stable key order via
  // the Struct field order above.
  const lines = dataset
    .map((d) => existing.get(d.id))
    .filter((r): r is Rubric => r !== undefined)
    .map((r) => JSON.stringify(r));
  yield* Effect.promise(() => Bun.write(rubricsUrl, lines.join("\n") + "\n"));
  console.log(`wrote rubrics.jsonl (${lines.length} entries) — review any RULING lines before trusting a bench`);
});

if (import.meta.main) {
  Effect.runPromise(main).catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
