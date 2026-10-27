// The balloon model, imported as its URL (see scripts/build-lib.ts).
declare module "*.glb" {
  const path: string;
  export = path;
}

// Rapier's WebAssembly glue (see src/rapier.ts), which has no types of its own.
declare module "@dimforge/rapier3d/rapier_wasm3d_bg.js" {
  export function __wbg_set_wasm(exports: WebAssembly.Exports): void;
}
