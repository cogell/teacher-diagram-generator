// Module shapes wrangler's bundler produces for the rules in wrangler.jsonc:
// Text rules import as strings, Data rules as ArrayBuffers, and .wasm files
// as precompiled WebAssembly.Modules. (*.md is declared in ../markdown.d.ts.)
declare module "*.jsonl" {
  const text: string;
  export default text;
}
declare module "*.ttf" {
  const data: ArrayBuffer;
  export default data;
}
declare module "*.wasm" {
  const mod: WebAssembly.Module;
  export default mod;
}
