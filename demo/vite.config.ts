// The demo site: the package used as any app would, through its build (dist/).
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  // One copy of each, shared with the package (its peer dependencies).
  resolve: { dedupe: ["react", "react-dom", "three"] },
  build: {
    outDir: "../build",
    emptyOutDir: true,
    rollupOptions: { input: { index: "index.html", docs: "docs.html", vanilla: "vanilla.html", prototype: "prototype.html" } },
  },
});
