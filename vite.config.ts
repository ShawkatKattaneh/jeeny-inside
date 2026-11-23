import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

export default defineConfig({
  root: "client",
  plugins: [react(), tailwindcss()],
  build: { outDir: "../dist", emptyOutDir: true },
  server: {
    host: true, // reachable from phones on the same hotspot / Wi-Fi
    port: 5173,
    strictPort: true,
    proxy: { "/api": "http://localhost:3001" },
  },
});
