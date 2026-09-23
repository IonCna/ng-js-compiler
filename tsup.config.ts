import { defineConfig } from "tsup";

export default defineConfig({
  entry: { index: "index.ts", esbuild: "esbuild.ts", vite: "vite.ts", contract: "contract.ts" },
  format: ["esm"],
  dts: true,
  clean: true,
  outDir: "dist",
  external: ["esbuild", "vite"],
});
