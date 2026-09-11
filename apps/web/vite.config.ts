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

// What the service worker precaches: the app shell and the screens that work
// with no network, and nothing else.
//
// Globbing every built file used to put all of it in the precache — 168 files,
// 4.4 MB, the Russian strings, the whole control panel, the map library, every
// guide — downloaded on a first visit and again after every release, by every
// device, whether or not anyone there ever opened those pages. Now the list is
// the shell (the entry chunk and everything it imports) plus these roots and
// everything THEY import, worked out from the bundle's own import graph, so a
// shared chunk they need can't be left behind by a naming accident.
//
// Everything else still loads over the network when it is opened, and then stays
// in the "isputnik-code" runtime cache below, so a page used once online opens
// offline too. A page never opened on this device has nothing to load offline;
// app/App.tsx catches that (shared/LoadErrorBoundary) instead of going blank.
const OFFLINE_ROOTS: { what: string; module: RegExp }[] = [
  // The offline shelf itself, and where it leads: the book page, the player, the
  // Recent/Continue lists built from downloads, and the two catalogs, whose API
  // answers the "isputnik-catalog" cache keeps for offline browsing.
  { what: "Downloads page", module: /\/features\/library\/DownloadsPage\.tsx$/ },
  { what: "book page", module: /\/features\/audiobooks\/BookDetailPage\.tsx$/ },
  { what: "player", module: /\/features\/audiobooks\/PlayerPage\.tsx$/ },
  { what: "Recent/Continue lists", module: /\/features\/library\/LibraryFeedPage\.tsx$/ },
  { what: "audiobooks/ebooks catalog", module: /\/features\/audiobooks\/catalog\/CatalogPage\.tsx$/ },
  // The reader opens each book format with an import() of its own, so a
  // downloaded EPUB or FB2 needs these to open offline.
  { what: "ebook reader formats", module: /\/vendor\/foliate-js\// },
  // The service-worker registration helper, imported lazily by the entry.
  { what: "workbox-window", module: /\/workbox-window\// }
];

function precacheScope() {
  const keep = new Set<string>();
  const drop = new Set<string>();
  let computed = false;

  const plugin: Plugin = {
    name: "isputnik-precache-scope",
    apply: "build",
    generateBundle(_options, bundle) {
      type Chunk = Extract<(typeof bundle)[string], { type: "chunk" }>;
      const chunks = Object.values(bundle).filter((file): file is Chunk => file.type === "chunk");
      const byFile = new Map(chunks.map((chunk) => [chunk.fileName, chunk]));
      const moduleOf = (chunk: Chunk) => (chunk.facadeModuleId ?? "").replace(/\\/g, "/");

      const roots = chunks.filter((chunk) => chunk.isEntry);
      for (const root of OFFLINE_ROOTS) {
        const found = chunks.filter((chunk) => root.module.test(moduleOf(chunk)));
        // A renamed or moved page must not silently stop working offline.
        if (found.length === 0) this.error(`precache: no chunk found for the ${root.what} (${root.module})`);
        roots.push(...found);
      }

      // Static imports only: a dynamic import is a page or feature of its own.
      const reached = new Set<Chunk>();
      const visit = (chunk: Chunk | undefined) => {
        if (!chunk || reached.has(chunk)) return;
        reached.add(chunk);
        for (const file of chunk.imports) visit(byFile.get(file));
      };
      roots.forEach(visit);

      // A chunk's CSS and its ?url assets (the flag font, say) go with the chunk.
      const filesOf = (chunk: Chunk) => {
        const meta = (chunk as Chunk & { viteMetadata?: { importedCss: Set<string>; importedAssets: Set<string> } }).viteMetadata;
        return [chunk.fileName, ...(meta?.importedCss ?? []), ...(meta?.importedAssets ?? [])];
      };
      keep.clear();
      drop.clear();
      for (const chunk of chunks) {
        for (const file of filesOf(chunk)) (reached.has(chunk) ? keep : drop).add(file);
      }
      computed = true;
    }
  };

  // Given workbox's glob results. Files the bundle knows about are kept only when
  // the shell or an offline root reaches them; anything it doesn't track (index.html,
  // the icons, the web manifest) passes through as before.
  const manifestTransform = async <T extends { url: string }>(entries: T[]) => {
    if (!computed) throw new Error("precache: the bundle's import graph was not recorded");
    const manifest = entries.filter((entry) => keep.has(entry.url) || !drop.has(entry.url));
    return { manifest, warnings: [] as string[] };
  };

  return { plugin, manifestTransform };
}

const precache = precacheScope();

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
    precache.plugin,
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
        // Precache the app shell so the UI boots with no network — the glob finds
        // the candidates, and precacheScope() (above) narrows the built code to
        // the shell and the offline screens. The guides are no longer precached:
        // a guide once read stays readable offline through the runtime cache
        // below, text and screenshots alike.
        globPatterns: ["**/*.{js,css,html,svg,woff2}"],
        manifestTransforms: [precache.manifestTransform],
        // SPA fallback mirrors the server's index.html catch-all — but never for
        // API calls, which must hit the network (or their own runtime cache).
        navigateFallback: "/index.html",
        navigateFallbackDenylist: [/^\/api\//],
        runtimeCaching: [
          {
            // The code the precache leaves out — the control panel, the gallery,
            // the Russian strings, the map library. Built files are content-hashed,
            // so a cached one can never be stale: cache-first, and a page opened
            // once online opens offline afterwards. A release's new files replace
            // old ones in here as they are used; the cap sweeps up what's left.
            urlPattern: ({ request, url }) =>
              (request.destination === "script" || request.destination === "style") &&
              url.origin === self.location.origin &&
              url.pathname.startsWith("/static/"),
            handler: "CacheFirst",
            options: {
              cacheName: "isputnik-code",
              expiration: { maxEntries: 250, maxAgeSeconds: 60 * 60 * 24 * 90 },
              cacheableResponse: { statuses: [200] }
            }
          },
          {
            // A guide once read stays readable offline. Stale-while-revalidate:
            // it opens at once and the next visit picks up an edited guide.
            urlPattern: ({ url }) => url.origin === self.location.origin && /^\/guides\/[^/]+\.md$/.test(url.pathname),
            handler: "StaleWhileRevalidate",
            options: {
              cacheName: "isputnik-guides",
              expiration: { maxEntries: 60, maxAgeSeconds: 60 * 60 * 24 * 90 },
              cacheableResponse: { statuses: [200] }
            }
          },
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
