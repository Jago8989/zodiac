import { writeFileSync } from "node:fs";

// The package root is `"type": "module"`, so every `.js` is treated as ESM by
// default. The CJS build emits CommonJS (`require`/`module.exports`), so its
// folder needs its own `package.json` flipping the type back to commonjs.
// The ESM marker is redundant but explicit.
writeFileSync("dist/esm/package.json", JSON.stringify({ type: "module" }) + "\n");
writeFileSync(
  "dist/cjs/package.json",
  JSON.stringify({ type: "commonjs" }) + "\n"
);
