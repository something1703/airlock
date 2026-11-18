import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [react()],
  build: { target: "es2022", sourcemap: "hidden" },
  // The app shows the same hand-made diagrams as the README (docs/images), so allow serving the repo root.
  server: { port: 5173, strictPort: true, fs: { allow: [".."] } },
});
