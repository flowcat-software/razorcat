/// <reference types="vitest/config" />
import { resolve } from "node:path";
import process from "node:process";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

const host = process.env.TAURI_DEV_HOST;
const page = (name: string) => resolve(import.meta.dirname, `${name}.html`);

// https://vite.dev/config/
export default defineConfig(() => ({
  plugins: [react()],

  // One entry per window type.
  build: {
    rolldownOptions: {
      input: {
        editor: page("editor"),
        settings: page("settings"),
        recorder: page("recorder"),
        picker: page("picker"),
        outline: page("outline"),
        countdown: page("countdown"),
      },
    },
  },

  // Tauri: don't obscure Rust errors; fixed port; don't watch src-tauri. Not Vandal's 1420:
  // with both in development, Vandal's window loaded Razorcat's pages.
  clearScreen: false,
  server: {
    port: 1430,
    strictPort: true,
    host: host || false,
    hmr: host ? { protocol: "ws", host, port: 1431 } : undefined,
    watch: { ignored: ["**/src-tauri/**", "**/spikes/**", "**/internal/**"] },
  },

  test: {
    include: ["src/**/*.test.ts", "scripts/**/*.test.mjs"],
  },
}));
