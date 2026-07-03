import { Config, Effect, Layer, Schema } from "effect";
import { LanguageModel, Response } from "effect/unstable/ai";
import { FetchHttpClient } from "effect/unstable/http";
import {
  OpenRouterClient,
  OpenRouterLanguageModel,
} from "@effect/ai-openrouter";

const OpenRouterLayer = OpenRouterClient.layerConfig({
  apiKey: Config.redacted("OPENROUTER_API_KEY"),
}).pipe(Layer.provide(FetchHttpClient.layer));

// A stronger, vision-capable judge than the generator. It never draws — it only
// looks at the rendered PNG and reasons about it, so we can afford the upgrade.
// Generous cap: Sonnet 5 is a reasoning model, so its thinking tokens count
// against max_tokens — too small a cap leaves nothing for the verdict text.
const EvaluatorModel = OpenRouterLanguageModel.model("anthropic/claude-sonnet-5", {
  max_tokens: 8000,
}).pipe(Layer.provide(OpenRouterLayer));

/**
 * The structured verdict the judge must return. Shaped to drop straight into the
 * explorer's `ratings.json` (`{ score, note }`). Deliberately minimal: a
 * pass/fail gate, a quantitative score, and one free-form critique — nothing
 * the reader has to wade through.
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
});
export type Evaluation = typeof Evaluation.Type;

/** Turn raw PNG bytes into the base64 data URL the model expects. */
const pngDataUrl = (png: Uint8Array) =>
  `data:image/png;base64,${Buffer.from(png).toString("base64")}`;

/** Raised when the judge's reply doesn't contain a parseable Evaluation. */
class EvaluationNotParsed extends Schema.TaggedErrorClass<EvaluationNotParsed>()(
  "EvaluationNotParsed",
  { output: Schema.String },
) { }

const decodeEvaluation = Schema.decodeUnknownEffect(Evaluation);

/**
 * Pull the JSON object out of the model's reply and decode it against the
 * `Evaluation` schema. We ask for raw JSON, but models sometimes wrap it in a
 * ```json fence or add stray prose — so we grab the outermost `{…}` and parse.
 */
const parseEvaluation = (text: string) =>
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
    return yield* decodeEvaluation(json);
  });

/**
 * The evaluator is `(request, png) → Evaluation`. A vision model looks at the
 * diagram the generator produced and the request it was meant to satisfy, then
 * returns a pass/fail verdict, a score, and a free-form critique.
 *
 * Returns the parsed `evaluation` plus the OpenRouter `generationId` (if any) so
 * the harness can look up real cost, mirroring `createDiagram`.
 */
export const evaluateDiagram = (params: {
  request: string;
  png: Uint8Array;
}) =>
  Effect.gen(function*() {
    const generation = yield* LanguageModel.generateText({
      prompt: [
        {
          role: "system",
          content:
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
            `made the diagram pass or fail`,
        },
        {
          role: "user",
          content: [
            {
              type: "text",
              text:
                `REQUEST:\n${params.request}\n\n` +
                `The generated diagram is attached. Rate it.`,
            },
            { type: "file", mediaType: "image/png", data: pngDataUrl(params.png) },
          ],
        },
      ],
    });

    const evaluation = yield* parseEvaluation(generation.text);

    const meta = generation.content.find(
      (p): p is Response.ResponseMetadataPart => p.type === "response-metadata",
    );

    return { evaluation, generationId: meta?.id };
  }).pipe(Effect.provide(EvaluatorModel));
