// The balloon model, imported as its URL (see scripts/build-lib.ts).
declare module "*.glb" {
  const path: string;
  export = path;
}
