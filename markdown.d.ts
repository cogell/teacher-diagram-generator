// Bun text imports: `import doc from "./file.md" with { type: "text" }`
declare module "*.md" {
  const text: string;
  export default text;
}
