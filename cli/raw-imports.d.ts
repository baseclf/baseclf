/**
 * Vite's `?raw` suffix, declared rather than pulled in wholesale.
 *
 * `cli/readme-documents.test.ts` reads the README and the example documents as text so
 * it can run them through the same code `baseclf policy apply` runs. Vite resolves the
 * suffix; the type checker needs telling.
 *
 * Declared here instead of adding `vite/client` to `types` in `tsconfig.json`, which
 * would put the DOM lib and every other Vite ambient in scope for the whole project.
 * This is a Worker and a Node CLI, and neither wants that.
 */
declare module '*?raw' {
  const content: string;
  export default content;
}
