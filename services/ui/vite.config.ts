import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// In dev, /api is proxied to the two services so the browser talks to one origin -
// the same shape nginx serves in the container, so code does not change between them.
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      "/api/assistant": { target: "http://127.0.0.1:4100", changeOrigin: true },
      "/api": { target: "http://127.0.0.1:4000", changeOrigin: true },
    },
  },
  build: { outDir: "dist", sourcemap: false, chunkSizeWarningLimit: 900 },
});
