import { Config, Effect, Layer, Schema } from "effect";
import { LanguageModel, Response } from "effect/unstable/ai";
import { FetchHttpClient } from "effect/unstable/http";
import {
  OpenRouterClient,
  OpenRouterLanguageModel,
} from "@effect/ai-openrouter";
import { Resvg } from "@resvg/resvg-js";

const OpenRouterLayer = OpenRouterClient.layerConfig({
  apiKey: Config.redacted("OPENROUTER_API_KEY"),
}).pipe(Layer.provide(FetchHttpClient.layer));

const GeneratorModel = OpenRouterLanguageModel.model("anthropic/claude-haiku-4.5", {
  max_tokens: 4000,
}).pipe(Layer.provide(OpenRouterLayer));

/**
 * The system instructions that steer the generator. Exported so the evaluator
 * (`evaluator.ts`) can critique the diagram against the very prompt that
 * produced it, and suggest concrete revisions to this exact text.
 */
export const GENERATOR_SYSTEM_PROMPT =
  `You generate K-12 math diagrams as SVG. Return ONE self-contained <svg> inside a \`\`\`svg code block, and nothing else.`;

/**
 * A generator is `String → Image`. This naive one asks a model for an
 * SVG, pulls it out of the reply, and rasterizes to PNG — but the SVG is just an
 * implementation detail. Produce the raster however you like; return the `png`
 * bytes, plus the OpenRouter `generationId` (if you have one) so the harness can
 * look up real cost.
 */
export const createDiagram = (request: string) =>
  Effect.gen(function*() {
    const generation = yield* LanguageModel.generateText({
      prompt: [
        { role: "system", content: GENERATOR_SYSTEM_PROMPT },
        { role: "user", content: request },
      ],
    });
    const svg = yield* extractSvgFromText(generation.text);
    const png = yield* Effect.try(() =>
      new Resvg(svg, {
        background: "white",
        fitTo: { mode: "width", value: 720 },
      })
        .render()
        .asPng(),
    );

    // We store OpenRouter's `generationId` for post-facto analytics (cost, latency, etc.)
    const meta = generation.content.find(
      (p): p is Response.ResponseMetadataPart => p.type === "response-metadata",
    );
    const generationId = meta?.id;

    return { png, generationId };
  }).pipe(Effect.provide(GeneratorModel));


/** Raised when the model's reply contains no <svg> element. */
class SvgNotFound extends Schema.TaggedErrorClass<SvgNotFound>()("SvgNotFound", {
  output: Schema.String,
}) { }

/**
 * Pulls the <svg>…</svg> out of the model's reply. The model wraps it in a
 * ```svg block, but the element is self-delimiting so we just grab it.
 */
const extractSvgFromText = (text: string): Effect.Effect<string, SvgNotFound> => {
  const m = text.match(/<svg[\s\S]*?<\/svg>/i);
  if (m && m[0]) {
    return Effect.succeed(m[0]);
  }
  return Effect.fail(new SvgNotFound({ output: text.slice(0, 200) }));
};
