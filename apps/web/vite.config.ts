import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { VitePWA } from "vite-plugin-pwa";

export default defineConfig({
  // The public dir ships an `Assets/` folder (capital A). Vite's default build
  // output dir is `assets` (lowercase); on case-insensitive filesystems the two
  // merge into one folder whose on-disk name wins, breaking case-sensitive static
  // servers that then 404 the hashed bundles. Use a distinct name to avoid it.
  build: { assetsDir: "static" },
  plugins: [
    react(),
    VitePWA({
      // The service worker self-updates in the background; the app reloads onto
      // the new version on the next navigation.
      registerType: "autoUpdate",
      injectRegister: "auto",
      includeAssets: ["Assets/brand/apple-touch-icon.png"],
      manifest: {
        name: "iSputnik Home",
        short_name: "iSputnik",
        description: "Your family audiobook & ebook library.",
        id: "/",
        start_url: "/",
        scope: "/",
        display: "standalone",
        orientation: "portrait",
        background_color: "#031116",
        theme_color: "#031116",
        icons: [
          { src: "/Assets/brand/pwa-icon-192.png", sizes: "192x192", type: "image/png" },
          { src: "/Assets/brand/pwa-icon-512.png", sizes: "512x512", type: "image/png" },
          {
            src: "/Assets/brand/pwa-icon-maskable-512.png",
            sizes: "512x512",
            type: "image/png",
            purpose: "maskable"
          }
        ]
      },
      workbox: {
        // Precache the app shell so the UI boots with no network.
        globPatterns: ["**/*.{js,css,html,svg,woff2}"],
        // SPA fallback mirrors the server's index.html catch-all — but never for
        // API calls, which must hit the network (or their own runtime cache).
        navigateFallback: "/index.html",
        navigateFallbackDenylist: [/^\/api\//],
        runtimeCaching: [
          {
            // Public app artwork/backgrounds are too large to precache, but once
            // seen they should remain available for installed offline launches.
            urlPattern: ({ request, url }) =>
              request.destination === "image" &&
              url.origin === self.location.origin &&
              (url.pathname.startsWith("/static/") || url.pathname.startsWith("/Assets/")),
            handler: "CacheFirst",
            options: {
              cacheName: "isputnik-static-images",
              expiration: { maxEntries: 100, maxAgeSeconds: 60 * 60 * 24 * 30 },
              cacheableResponse: { statuses: [0, 200] }
            }
          },
          {
            // Covers can be replaced in place (a manual cover edit overwrites the
            // file under the same key), so prefer the network — with the cover
            // ETag an unchanged cover is a cheap 304 — and fall back to the cache
            // only when offline, so a changed cover shows on the next refresh.
            urlPattern: /\/api\/library\/covers\//,
            handler: "NetworkFirst",
            options: {
              cacheName: "isputnik-covers",
              networkTimeoutSeconds: 3,
              expiration: { maxEntries: 500, maxAgeSeconds: 60 * 60 * 24 * 30 },
              cacheableResponse: { statuses: [200] }
            }
          },
          {
            // Catalog/list JSON: always try the network first so it stays fresh,
            // fall back to the last successful response when offline.
            // NOTE: audio stream/download endpoints are deliberately omitted here
            // so they always go to the network — offline audio is Phase 2.
            urlPattern: /\/api\/library\/(audiobook-libraries|ebook-libraries|audiobooks\/facets|categories|tags|books\/[^/]+$)/,
            handler: "NetworkFirst",
            options: {
              cacheName: "isputnik-catalog",
              networkTimeoutSeconds: 5,
              expiration: { maxEntries: 200, maxAgeSeconds: 60 * 60 * 24 },
              cacheableResponse: { statuses: [200] }
            }
          }
        ]
      },
      devOptions: {
        // Keep the SW off in `vite dev` to avoid stale-cache confusion while coding.
        enabled: false
      }
    })
  ],
  server: {
    port: 5173,
    proxy: {
      "/api": {
        target: "http://127.0.0.1:4000",
        changeOrigin: true
      }
    }
  },
  // `vite preview` serves the production build (with the real service worker),
  // so mirror the API proxy here too.
  preview: {
    port: 4173,
    proxy: {
      "/api": {
        target: "http://127.0.0.1:4000",
        changeOrigin: true
      }
    }
  }
});
