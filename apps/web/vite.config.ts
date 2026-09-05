import { createReadStream, cpSync, existsSync, rmSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig, type Plugin } from "vite";
import react from "@vitejs/plugin-react";
import { VitePWA } from "vite-plugin-pwa";

// Content types for what a guide is allowed to be made of. Anything else in
// docs/users/ is not served rather than guessed at.
const GUIDE_TYPES: Record<string, string> = {
  ".md": "text/markdown; charset=utf-8",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".gif": "image/gif",
  ".svg": "image/svg+xml"
};

// The user guides are authored in docs/users/ and reviewed with the code. For a
// BUILD they are copied into public/ so they end up in dist: a self-hosted
// library on a LAN with no internet still has its documentation, and what it
// shows always matches the version installed. The copy is generated output —
// gitignored, rebuilt on every build.
//
// DEV serves them straight out of docs/users/ instead, for two reasons. Editing a
// guide used to need a server restart, because the copy only ran at startup. And
// the copied images did not serve at all: the copy happens inside configureServer,
// which is too late for Vite's public-directory handling to know about the files,
// so every request for one fell through to the SPA fallback and returned
// index.html — a Help page full of blank images, while the same files were fine
// in a production build. Serving the source directory sidesteps both.
function userGuides(): Plugin {
  const from = fileURLToPath(new URL("../../docs/users", import.meta.url));
  const to = fileURLToPath(new URL("./public/guides", import.meta.url));
  const sync = () => {
    rmSync(to, { recursive: true, force: true });
    cpSync(from, to, { recursive: true });
  };
  return {
    name: "isputnik-user-guides",
    buildStart: sync,
    configureServer(server) {
      server.middlewares.use((request, response, next) => {
        const url = (request.url ?? "").split("?")[0];
        if (!url.startsWith("/guides/")) return next();

        let file: string;
        try {
          file = path.join(from, decodeURIComponent(url.slice("/guides/".length)));
        } catch {
          return next();                       // malformed percent-encoding
        }
        // Refuse anything that resolves outside docs/users — "/guides/../../.env"
        // is a request a browser can make.
        if (file !== from && !file.startsWith(from + path.sep)) return next();

        const type = GUIDE_TYPES[path.extname(file).toLowerCase()];
        if (!type || !existsSync(file) || !statSync(file).isFile()) return next();

        response.setHeader("Content-Type", type);
        response.setHeader("Cache-Control", "no-cache");
        createReadStream(file).pipe(response);
      });
    }
  };
}

// Which port to serve on. Normally the familiar ones — 5173 for `npm run dev`,
// 4173 for `npm run preview` — but honour PORT when something sets it, so a
// runner that has to pick its own port (.claude/launch.json "autoPort") lands
// where it expects rather than fighting a hardcoded number.
//
// The server half of `npm run dev` is unaffected: the root script pins it with
// `cross-env PORT=4000` for that subprocess only, which also keeps the /api
// proxy target below correct.
const port = (fallback: number): number => {
  const fromEnv = Number(process.env.PORT);
  return Number.isInteger(fromEnv) && fromEnv > 0 ? fromEnv : fallback;
};

export default defineConfig({
  // The public dir ships an `Assets/` folder (capital A). Vite's default build
  // output dir is `assets` (lowercase); on case-insensitive filesystems the two
  // merge into one folder whose on-disk name wins, breaking case-sensitive static
  // servers that then 404 the hashed bundles. Use a distinct name to avoid it.
  build: {
    assetsDir: "static",
    // Routes are lazy (see app/App.tsx), which left the bundler emitting a chunk
    // per shared leaf — fifty-odd files under 2 KB, most of them a single lucide
    // icon used by two routes. That is request overhead, not code splitting, and
    // it lands hardest on the LAN/HTTP-1.1 deployments this app is built for.
    // Group the shared vendor code by library instead: one icon chunk and one
    // React chunk, both cached across every route. Leaflet and marked are left
    // alone — they are already isolated behind their own dynamic imports.
    rolldownOptions: {
      output: {
        advancedChunks: {
          groups: [
            { name: "icons", test: /node_modules[\\/]lucide-react[\\/]/ },
            { name: "react", test: /node_modules[\\/](react|react-dom|scheduler)[\\/]/ }
          ]
        }
      }
    }
  },
  // Docs ship in the repo and change with the code, so a Help link has to point at
  // the ref THIS build came from — otherwise a 2.1.0 install reads 2.3.x guides
  // describing features it doesn't have. CI passes the tag or branch it built
  // (DOCS_REF = github.ref_name, always a real ref); a local build says "main".
  define: { __DOCS_REF__: JSON.stringify(process.env.DOCS_REF || "main") },
  plugins: [
    react(),
    userGuides(),
    VitePWA({
      // The service worker self-updates in the background; the app reloads onto
      // the new version on the next navigation.
      registerType: "autoUpdate",
      injectRegister: null,
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
        // Precache the app shell so the UI boots with no network. The guides are
        // included — all nineteen are ~160 KB of text, and help is exactly what
        // you want when something isn't working. Their screenshots are ~3 MB and
        // are NOT precached; they load over the network and stick in the runtime
        // image cache below, so an offline guide reads fine minus the pictures.
        globPatterns: ["**/*.{js,css,html,svg,woff2}", "guides/*.md"],
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
              (url.pathname.startsWith("/static/")
                || url.pathname.startsWith("/Assets/")
                || url.pathname.startsWith("/guides/")),
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
    port: port(5173),
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
    port: port(4173),
    proxy: {
      "/api": {
        target: "http://127.0.0.1:4000",
        changeOrigin: true
      }
    }
  }
});
