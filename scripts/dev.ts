// Development: rebuilds the package on every change and runs the demo (a
// Vite app using the package like any other app would) with hot reload.
import { $ } from "bun";

const pkg = "packages/balloon-writer";
await $`bun run --cwd ${pkg} build`;
const lib = Bun.spawn(["bun", "run", "--cwd", pkg, "dev"], { stdio: ["inherit", "inherit", "inherit"] });
const demo = Bun.spawn(["bun", "run", "--cwd", "demo", "dev"], { stdio: ["inherit", "inherit", "inherit"] });
process.on("SIGINT", () => {
  lib.kill();
  demo.kill();
  process.exit();
});
await Promise.race([lib.exited, demo.exited]);
lib.kill();
demo.kill();
