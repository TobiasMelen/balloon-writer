// Rapier, the physics engine, loaded our way: its JS is bundled into the
// engine and its WebAssembly ships beside it as rapier.wasm, compiled while it
// downloads when the balloons start. (Rapier's own package imports the .wasm
// as a module, which bundlers only do with extra setup; the build swaps that
// import out, see scripts/build.ts.)
import * as RAPIER from "@dimforge/rapier3d";
import * as glue from "@dimforge/rapier3d/rapier_wasm3d_bg.js";

let loading: Promise<void> | null = null;
/** Loads Rapier's WebAssembly, once. Needs the page's CSP to allow
 *  compiling WebAssembly ('wasm-unsafe-eval'), if it sets one. */
export const initRapier = () =>
  (loading ??= (async () => {
    const url = new URL("./rapier.wasm", import.meta.url);
    const imports = { "./rapier_wasm3d_bg.js": glue as unknown as WebAssembly.ModuleImports };
    // Streaming needs the server to send it as application/wasm; otherwise
    // compile it once downloaded.
    const { instance } = await WebAssembly.instantiateStreaming(fetch(url), imports).catch(async () =>
      WebAssembly.instantiate(await (await fetch(url)).arrayBuffer(), imports),
    );
    glue.__wbg_set_wasm(instance.exports);
  })());

export default RAPIER;
