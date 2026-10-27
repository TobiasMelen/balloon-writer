// Builds the package into dist/: ES modules with their dependencies left
// as imports, the balloon model beside them, and type declarations. With
// --watch, rebuilds whenever src/ changes (for the demo's dev server).
//
// The model is imported as a URL in the source. In the package it becomes
// `new URL("./alphabet.glb", import.meta.url)`, which the consumer's bundler
// (Vite, webpack, Rollup, Parcel, Next) resolves and copies.
import { $ } from "bun";
import { watch } from "node:fs";
import { basename } from "node:path";

// Run with NODE_ENV=production (as the package scripts do) for React's
// production JSX runtime; Bun picks it at startup.

const watching = process.argv.includes("--watch");

async function build() {
  // Not while watching: the demo would see the package vanish mid-rebuild.
  if (!watching) await $`rm -rf dist`;
  await $`bun scripts/font.ts`;
  const result = await Bun.build({
    entrypoints: ["src/index.ts", "src/react.tsx", "src/soundTuning.ts"],
    outdir: "dist",
    target: "browser",
    format: "esm",
    // One copy of the sound settings, shared by both entry points.
    splitting: true,
    packages: "external",
    sourcemap: "linked",
    plugins: [
      {
        name: "glb-url",
        setup(build) {
          build.onLoad({ filter: /\.glb$/ }, async ({ path }) => {
            const name = basename(path);
            await Bun.write(`dist/${name}`, Bun.file(path));
            return { contents: `export default new URL(${JSON.stringify(`./${name}`)}, import.meta.url).href;`, loader: "js" };
          });
        },
      },
    ],
  });
  if (!result.success) {
    for (const log of result.logs) console.error(log);
    return false;
  }
  const types = await $`bunx tsc -p tsconfig.lib.json`.nothrow();
  return types.exitCode === 0;
}

if (!watching) {
  if (!(await build())) process.exit(1);
  console.log("Built dist/:", (await $`ls dist`.text()).trim().split("\n").join(", "));
} else {
  await build();
  console.log("Watching src/ for the package build.");
  let timer: Timer | undefined;
  let running = Promise.resolve(true);
  watch("src", { recursive: true }, () => {
    clearTimeout(timer);
    timer = setTimeout(() => {
      running = running.then(build).then((ok) => (console.log(ok ? "Rebuilt dist/." : "Package build failed."), ok));
    }, 100);
  });
}
