import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [react()],
  build: { target: "es2022", sourcemap: "hidden" },
  server: { port: 5173, strictPort: true },
});
