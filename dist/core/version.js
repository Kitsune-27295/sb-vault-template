import { readFileSync } from "node:fs";
// Single source of truth for the engine version: the `package.json` at the package root.
// `src/core/` and the compiled `dist/core/` are both two levels below it, so the same
// relative path works in the repository, in the tests and in a deployed vault.
export const ENGINE_VERSION = JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf8")).version;
//# sourceMappingURL=version.js.map