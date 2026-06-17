import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [react()],
  build: {
    outDir: "dist",
    emptyOutDir: true,
  },
  server: {
    proxy: {
      "/api": "http://127.0.0.1:7879",
      "/health": "http://127.0.0.1:7879",
      "/rpc": "http://127.0.0.1:7879",
      "/runs": "http://127.0.0.1:7879",
    },
  },
});
