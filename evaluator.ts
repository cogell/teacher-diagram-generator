import { Config, Effect, Layer, Schema } from "effect";
import { LanguageModel, Response } from "effect/unstable/ai";
import { FetchHttpClient } from "effect/unstable/http";
import {
  OpenRouterClient,
  OpenRouterLanguageModel,
} from "@effect/ai-openrouter";
import type { Rubric } from "./rubrics";

const OpenRouterLayer = OpenRouterClient.layerConfig({
  apiKey: Config.redacted("OPENROUTER_API_KEY"),
}).pipe(Layer.provide(FetchHttpClient.layer));

// A stronger, vision-capable judge than the generator. It never draws — it only
// looks at the rendered PNG and reasons about it, so we can afford the upgrade.
// Generous cap: Sonnet 5 is a reasoning model, so its thinking tokens count
// against max_tokens — too small a cap leaves nothing for the verdict text.
//
// Temperature is a parameter because the judge runs at 0 (a ruler should not
// sample) — but a malformed reply at t=0 is DETERMINISTIC, so the retry path
// re-rolls at a higher temperature instead of replaying the same bad reply.
const evaluatorModel = (temperature: number) =>
  OpenRouterLanguageModel.model("anthropic/claude-sonnet-5", {
    max_tokens: 8000,
    temperature,
  }).pipe(Layer.provide(OpenRouterLayer));

/**
 * The stored verdict — what lands in `ratings.json`. `passes`/`score`/`critique`
 * keep their historical meaning for the explorer. `checks` appears in rubric
 * mode: one entry per rubric item (facts, forbidden, plus the uniform
 * legibility check), with the item text written by CODE from the rubric — the
 * stored rating is self-describing without the rubric file, and cross-run
 * diffs join on `item` verbatim. In rubric mode `passes` is COMPUTED
 * (`checks.every(ok)`), never taken from the model.
 */
export const Evaluation = Schema.Struct({
  passes: Schema.Boolean.annotate({
    description:
      "true only if the diagram serves the request correctly and legibly as-is — right content, to scale, no clipped or occluded text.",
  }),
  score: Schema.Number.annotate({
    description:
      "Overall quality of the diagram as a K-12 math teaching aid, 0 (unusable) to 5 (excellent). Whole or half numbers.",
  }),
  critique: Schema.String.annotate({
    description:
      "A concise, free-form assessment: does the image depict what the request asked for, and is it clear, correct, and legible? Call out anything that made it pass or fail.",
  }),
  checks: Schema.optionalKey(Schema.Array(Schema.Struct({
    item: Schema.String,
    kind: Schema.Literals(["fact", "forbidden", "legibility"]),
    ok: Schema.Boolean,
    note: Schema.String,
  }))),
});
export type Evaluation = typeof Evaluation.Type;

/**
 * The wire shape the model actually replies with. In rubric mode the model
 * reports per-item verdicts BY INDEX (echoing item text invites paraphrase
 * that can't be matched) and is not asked for `passes` at all — asking for a
 * verdict code will overwrite invites the model to argue with the checklist.
 */
const JudgeReply = Schema.Struct({
  passes: Schema.optionalKey(Schema.Boolean),
  score: Schema.Number,
  critique: Schema.String,
  checks: Schema.optionalKey(Schema.Array(Schema.Struct({
    i: Schema.Number,
    ok: Schema.Boolean,
    note: Schema.optionalKey(Schema.String),
  }))),
});

/** Turn raw PNG bytes into the base64 data URL the model expects. */
const pngDataUrl = (png: Uint8Array) =>
  `data:image/png;base64,${Buffer.from(png).toString("base64")}`;

/** Raised when the judge's reply doesn't contain a valid verdict — no JSON,
 *  schema mismatch, or (rubric mode) a checks list that isn't exactly the
 *  requested indices. Retried at a bumped temperature; NEVER converted into a
 *  pass/fail verdict, which would turn model sloppiness into fake diagram
 *  failures. */
class EvaluationNotParsed extends Schema.TaggedErrorClass<EvaluationNotParsed>()(
  "EvaluationNotParsed",
  { output: Schema.String },
) { }

const decodeJudgeReply = Schema.decodeUnknownEffect(JudgeReply);

/**
 * Pull the JSON object out of the model's reply and decode it. We ask for raw
 * JSON, but models sometimes wrap it in a ```json fence or add stray prose —
 * so we grab the outermost `{…}` and parse.
 */
const parseJudgeReply = (text: string) =>
  Effect.gen(function*() {
    const start = text.indexOf("{");
    const end = text.lastIndexOf("}");
    if (start === -1 || end <= start) {
      return yield* Effect.fail(new EvaluationNotParsed({ output: text.slice(0, 200) }));
    }
    const json = yield* Effect.try({
      try: () => JSON.parse(text.slice(start, end + 1)) as unknown,
      catch: () => new EvaluationNotParsed({ output: text.slice(start, start + 200) }),
    });
    return yield* decodeJudgeReply(json).pipe(
      Effect.mapError(() => new EvaluationNotParsed({ output: text.slice(start, start + 200) })),
    );
  });

/** One checklist entry as shown to the judge and stored in the rating. */
interface ChecklistItem {
  item: string;
  kind: "fact" | "forbidden" | "legibility";
}

/**
 * The uniform legibility check appended by CODE to every rubric — owned here,
 * not in rubrics.jsonl, so rubric edits can't weaken or drift the one check
 * every diagram shares.
 */
const LEGIBILITY_ITEM: ChecklistItem = {
  kind: "legibility",
  item:
    "All text legible: no characters clipped by the image edge, no line or shape passing through characters, no labels overlapping each other",
};

const buildChecklist = (rubric: Rubric): ChecklistItem[] => [
  ...rubric.facts.map((item): ChecklistItem => ({ item, kind: "fact" })),
  ...rubric.forbidden.map((item): ChecklistItem => ({ item, kind: "forbidden" })),
  LEGIBILITY_ITEM,
];

const HOLISTIC_SYSTEM_PROMPT =
  `You are a meticulous evaluator of K-12 math teaching diagrams. ` +
  `You are shown (1) a student/teacher REQUEST and (2) the resulting ` +
  `PNG image. Judge how well the image serves the request as a teaching ` +
  `aid: does it depict the right thing, is it mathematically correct, and ` +
  `is it clear and legible?\n\n` +
  `Pay special attention to scale: every drawn magnitude must match its ` +
  `labeled value. Trace each bar, point, or shaded region to the axis or ` +
  `grid and confirm it lines up — a bar labeled 9 must end exactly at the ` +
  `9 tick, a dot at 3/4 must sit three quarters of the way along the line ` +
  `— and check that proportions between objects hold (a bar for 9 must be ` +
  `1.5x as long as a bar for 6). An out-of-scale drawing fails even when ` +
  `it looks tidy.\n\n` +
  `Also audit every piece of text in the image. Before your verdict, ` +
  `write a short inspection: list each label you can see, and for each ` +
  `one note (a) whether any character is cut off by the image edge, and ` +
  `(b) whether any line, curve, or shape passes through the characters ` +
  `(e.g. a dashed diagonal running straight through a label), or another ` +
  `label collides with it. Any of these makes the diagram fail — note ` +
  `each affected label in your critique.\n\n` +
  `After the inspection, respond with a single JSON object (no markdown, ` +
  `no code fences) with exactly these keys:\n` +
  `- "passes": boolean, true only if the diagram serves the request ` +
  `correctly and legibly as-is\n` +
  `- "score": number 0-5 (whole or half), overall teaching quality\n` +
  `- "critique": string, a concise free-form assessment that notes what ` +
  `made the diagram pass or fail`;

const rubricSystemPrompt = (rubric: Rubric, count: number) =>
  `You are a meticulous evaluator of K-12 math teaching diagrams. ` +
  `You are shown a student/teacher REQUEST, a numbered CHECKLIST derived from ` +
  `it, and the resulting PNG image. Your job is to verify the fixed checklist ` +
  `against the image — you do not deliver an overall verdict.\n\n` +
  `For each numbered item decide ok: true or false. ok: true ONLY if you can ` +
  `positively verify the item from the image; if the required element is ` +
  `absent, illegible, or you cannot tell, ok: false — say why in the note. ` +
  `Items marked [FORBIDDEN] name things that must NOT appear: for those, ` +
  `ok: true means you confirmed the thing is ABSENT.\n\n` +
  `When an item involves a magnitude or position, verify it by tracing to the ` +
  `axis, gridlines, or neighboring elements — a bar labeled 9 must end at the ` +
  `9 tick, a dot at 3/4 must sit three quarters of the way along the line — ` +
  `and check that proportions between objects hold. Out-of-scale fails the ` +
  `item even when the drawing looks tidy.\n\n` +
  `For the [LEGIBILITY] item, first write a short inspection: list each label ` +
  `you can see and note whether any character is cut off by the image edge, ` +
  `any line or shape passes through characters, or labels collide. The item ` +
  `is ok only if none of that occurs.\n\n` +
  ("ruling" in rubric && rubric.ruling
    ? `INTERPRETATION RULING (already settled — do not re-litigate it): ${rubric.ruling}\n\n`
    : "") +
  `After your inspection, respond with a single JSON object (no markdown, no ` +
  `code fences) with exactly these keys:\n` +
  `- "checks": array of EXACTLY ${count} entries, one per checklist item, in ` +
  `order, each {"i": <item number 1..${count}>, "ok": boolean, "note": string ` +
  `(brief reason)}\n` +
  `- "score": number 0-5 (whole or half), overall teaching quality\n` +
  `- "critique": string, concise summary naming any failed items`;

const checklistText = (items: ChecklistItem[]) =>
  items
    .map((c, idx) =>
      `${idx + 1}. ${c.kind === "forbidden" ? "[FORBIDDEN] " : c.kind === "legibility" ? "[LEGIBILITY] " : ""}${c.item}`,
    )
    .join("\n");

/**
 * The evaluator is `(request, png, rubric?) → Evaluation`. A vision model looks
 * at the diagram the generator produced and the request it was meant to
 * satisfy.
 *
 * With a `rubric` (see rubrics.ts) the judge verifies a numbered checklist —
 * the rubric's facts and forbidden items plus a uniform legibility check — and
 * `passes` is computed in code as "every check ok". Fact-level verdicts are
 * far lower variance than a holistic 0-5 ruling, and a score change across
 * runs becomes "which fact flipped". Without a rubric, the original holistic
 * judging is unchanged.
 *
 * The judge runs at temperature 0. A reply that can't be parsed/validated is
 * retried up to twice at temperature 0.4 — at t=0 the same prompt would just
 * replay the same malformed reply.
 *
 * Returns the parsed `evaluation` plus the OpenRouter `generationId` (if any)
 * so the harness can look up real cost, mirroring `createDiagram`.
 */
export const evaluateDiagram = (params: {
  request: string;
  png: Uint8Array;
  rubric?: Rubric;
}) => {
  const checklist = params.rubric ? buildChecklist(params.rubric) : null;

  const attempt = (temperature: number) =>
    Effect.gen(function*() {
      const generation = yield* LanguageModel.generateText({
        prompt: [
          {
            role: "system",
            content: checklist && params.rubric
              ? rubricSystemPrompt(params.rubric, checklist.length)
              : HOLISTIC_SYSTEM_PROMPT,
          },
          {
            role: "user",
            content: [
              {
                type: "text",
                text:
                  `REQUEST:\n${params.request}\n\n` +
                  (checklist ? `CHECKLIST:\n${checklistText(checklist)}\n\n` : "") +
                  `The generated diagram is attached. ${checklist ? "Verify the checklist." : "Rate it."}`,
              },
              { type: "file", mediaType: "image/png", data: pngDataUrl(params.png) },
            ],
          },
        ],
      }).pipe(Effect.provide(evaluatorModel(temperature)));

      const reply = yield* parseJudgeReply(generation.text);

      let evaluation: Evaluation;
      if (checklist) {
        // Validate the checks list hard: present, and indices exactly the set
        // 1..N (sorted here — order isn't trusted). Anything else is a bad
        // REPLY, not a bad diagram: fail to retry, never to a verdict.
        const checks = reply.checks;
        if (!checks || checks.length !== checklist.length
          || ![...checks].sort((a, b) => a.i - b.i).every((c, idx) => c.i === idx + 1)) {
          return yield* Effect.fail(
            new EvaluationNotParsed({ output: `bad checks list: ${JSON.stringify(reply.checks)?.slice(0, 200)}` }),
          );
        }
        const stored = [...checks]
          .sort((a, b) => a.i - b.i)
          .map((c, idx) => ({
            item: checklist[idx]!.item,
            kind: checklist[idx]!.kind,
            ok: c.ok,
            note: c.note ?? "",
          }));
        evaluation = {
          passes: stored.every((c) => c.ok),
          score: reply.score,
          critique: reply.critique,
          checks: stored,
        };
        // Tripwire for rubric under-coverage: every fact verified, yet the
        // holistic score says the diagram is bad — the rubric is missing a
        // check that matters.
        if (evaluation.passes && evaluation.score <= 2) {
          console.warn(`rubric tripwire: all checks ok but score ${evaluation.score} — rubric may under-cover this request`);
        }
      } else {
        if (reply.passes === undefined) {
          return yield* Effect.fail(new EvaluationNotParsed({ output: generation.text.slice(0, 200) }));
        }
        evaluation = { passes: reply.passes, score: reply.score, critique: reply.critique };
      }

      const meta = generation.content.find(
        (p): p is Response.ResponseMetadataPart => p.type === "response-metadata",
      );
      return { evaluation, generationId: meta?.id };
    });

  // t=0 first; on an unparseable reply, re-roll (twice) at 0.4. Provider
  // errors are NOT retried here — the harness already handles a failed eval.
  return attempt(0).pipe(
    Effect.catchTag("EvaluationNotParsed", () => attempt(0.4)),
    Effect.catchTag("EvaluationNotParsed", () => attempt(0.4)),
  );
};
