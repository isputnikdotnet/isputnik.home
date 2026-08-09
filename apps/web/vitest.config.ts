import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";

// Kept separate from vite.config.ts on purpose. That config carries the PWA
// plugin, the user-guide copier and the asset/chunking rules — all of which are
// about producing a build, and none of which a test run should have to do.
export default defineConfig({
  plugins: [react()],
  // Vite injects this at build time (see vite.config.ts); tests need it too.
  define: { __DOCS_REF__: JSON.stringify("test") },
  test: {
    environment: "jsdom",
    include: ["test/**/*.test.{ts,tsx}"],
    setupFiles: ["./test/setup.ts"],
    restoreMocks: true
  }
});
