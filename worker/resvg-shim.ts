/**
 * Workers-side stand-in for `@resvg/resvg-js`. The native package is a napi
 * module that can't run on Cloudflare, so wrangler.jsonc aliases the package
 * name to this file, which re-exposes the same `Resvg` class backed by
 * `@resvg/resvg-wasm` — generator.ts keeps its import untouched.
 *
 * Two Workers-specific gaps this papers over:
 *  - the wasm build must be initialized once (`configureResvg`, called from
 *    worker/index.ts with the bundled module) before any construction;
 *  - Workers have no system fonts, so `font-family:sans-serif` would render
 *    no text at all — every construction injects the bundled font buffers.
 */
import { Resvg as WasmResvg, initWasm, type ResvgRenderOptions } from "@resvg/resvg-wasm";

let fontBuffers: Uint8Array[] = [];
let wasmReady: Promise<void> | undefined;

export const configureResvg = (wasm: WebAssembly.Module, fonts: Uint8Array[]): Promise<void> => {
  fontBuffers = fonts;
  wasmReady ??= initWasm(wasm);
  return wasmReady;
};

export class Resvg extends WasmResvg {
  constructor(svg: string | Uint8Array, options?: ResvgRenderOptions) {
    super(svg, {
      ...options,
      font: {
        loadSystemFonts: false,
        fontBuffers,
        defaultFontFamily: "DejaVu Sans",
        sansSerifFamily: "DejaVu Sans",
        ...(options?.font ?? {}),
      },
    });
  }
}
