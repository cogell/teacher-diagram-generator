import { Config, Effect, Layer, Schema } from "effect";
import { LanguageModel, Response } from "effect/unstable/ai";
import { FetchHttpClient } from "effect/unstable/http";
import {
  OpenRouterClient,
  OpenRouterLanguageModel,
} from "@effect/ai-openrouter";
import { GENERATOR_SYSTEM_PROMPT } from "./generator";

const OpenRouterLayer = OpenRouterClient.layerConfig({
  apiKey: Config.redacted("OPENROUTER_API_KEY"),
}).pipe(Layer.provide(FetchHttpClient.layer));

// A stronger, vision-capable judge than the generator. It never draws — it only
// looks at the rendered PNG and reasons about it, so we can afford the upgrade.
const EvaluatorModel = OpenRouterLanguageModel.model("anthropic/claude-sonnet-4.5", {
  max_tokens: 4000,
}).pipe(Layer.provide(OpenRouterLayer));

/**
 * The structured verdict the judge must return. Shaped to drop straight into the
 * explorer's `ratings.json` (`{ score, note }`), with the prompt-improvement
 * fields alongside so an improvement loop can act on them.
 */
export const Evaluation = Schema.Struct({
  score: Schema.Number.annotate({
    description:
      "Overall quality of the diagram as a K-12 math teaching aid, 0 (unusable) to 5 (excellent). Whole or half numbers.",
  }),
  critique: Schema.String.annotate({
    description:
      "A concise qualitative assessment: does the image actually depict what the request asked for, and is it clear, correct, and legible?",
  }),
  strengths: Schema.Array(Schema.String).annotate({
    description: "What this diagram gets right. Empty if nothing stands out.",
  }),
  issues: Schema.Array(Schema.String).annotate({
    description:
      "Concrete visual/mathematical problems (mislabeled axes, wrong values, clipping, illegible text, missing elements, etc.).",
  }),
  suggestedSystemPrompt: Schema.String.annotate({
    description:
      "A full rewrite of the system prompt that would fix the observed issues across cases like this one. Keep it general — it steers ALL diagrams, not just this request.",
  }),
  promptChangeRationale: Schema.String.annotate({
    description:
      "Why the suggested prompt changes address the issues seen in this image.",
  }),
});
export type Evaluation = typeof Evaluation.Type;

/** Turn raw PNG bytes into the base64 data URL the model expects. */
const pngDataUrl = (png: Uint8Array) =>
  `data:image/png;base64,${Buffer.from(png).toString("base64")}`;

/**
 * The evaluator is `(request, png, systemPrompt) → Evaluation`. A vision model
 * looks at the diagram the generator produced, the request it was meant to
 * satisfy, and the exact system prompt that steered it — then rates the image
 * qualitatively and proposes a better system prompt.
 *
 * Returns the parsed `evaluation` plus the OpenRouter `generationId` (if any) so
 * the harness can look up real cost, mirroring `createDiagram`.
 */
export const evaluateDiagram = (params: {
  request: string;
  png: Uint8Array;
  /** Defaults to the generator's live system prompt. */
  systemPrompt?: string;
}) =>
  Effect.gen(function*() {
    const systemPrompt = params.systemPrompt ?? GENERATOR_SYSTEM_PROMPT;

    const generation = yield* LanguageModel.generateObject({
      schema: Evaluation,
      objectName: "Evaluation",
      prompt: [
        {
          role: "system",
          content:
            `You are a meticulous evaluator of K-12 math teaching diagrams. ` +
            `You are shown (1) a student/teacher REQUEST, (2) the SYSTEM PROMPT that ` +
            `was used to generate a diagram for that request, and (3) the resulting ` +
            `PNG image. Judge how well the image serves the request as a teaching ` +
            `aid: does it depict the right thing, is it mathematically correct, and ` +
            `is it clear and legible? Then propose an improved system prompt that ` +
            `would raise quality across many requests like this one — not an ` +
            `answer tailored to just this image.`,
        },
        {
          role: "user",
          content: [
            {
              type: "text",
              text:
                `REQUEST:\n${params.request}\n\n` +
                `CURRENT SYSTEM PROMPT (the text to improve):\n"""\n${systemPrompt}\n"""\n\n` +
                `The generated diagram is attached. Rate it and suggest an improved system prompt.`,
            },
            { type: "file", mediaType: "image/png", data: pngDataUrl(params.png) },
          ],
        },
      ],
    });

    const meta = generation.content.find(
      (p): p is Response.ResponseMetadataPart => p.type === "response-metadata",
    );

    return { evaluation: generation.value, generationId: meta?.id };
  }).pipe(Effect.provide(EvaluatorModel));
