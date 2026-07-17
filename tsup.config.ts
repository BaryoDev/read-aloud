import { defineConfig } from "tsup";

export default defineConfig({
  entry: {
    index: "src/index.ts", // browser: headless controller, highlighting, optional widget
    server: "src/server.ts", // node: the Edge-TTS engine + endpoint handler
  },
  format: ["esm", "cjs"],
  dts: true,
  clean: true,
  sourcemap: true,
  // Keep the Node WebSocket dep out of the browser bundle; it's only used by ./server.
  external: ["ws", "node:crypto", "node:buffer"],
  outExtension({ format }) {
    return { js: format === "cjs" ? ".cjs" : ".js" };
  },
});
