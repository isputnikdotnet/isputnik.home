// Acknowledgements for the open-source software (and data) the app is built on,
// grouped by the feature they power. Curated by hand — it includes things that aren't
// npm dependencies (the vendored reader, the face-recognition models, map tiles), so
// it's intentionally not auto-generated from package.json.
//
// Group names are translated (UI chrome); each item's use/license description
// stays English — third-party attribution and license identifiers (MIT, CC BY
// 4.0, etc.) are technical/legal text best left canonical, not localized.

import { useTranslation } from "react-i18next";

interface Credit { name: string; use: string; license: string; url: string }

const CREDITS: { groupKey: "reading" | "faceRecognition" | "photosVideo" | "locations" | "audiobooks" | "serverCore" | "app"; items: Credit[] }[] = [
  {
    groupKey: "reading",
    items: [
      { name: "foliate-js", use: "The EPUB & FB2 reader engine", license: "MIT", url: "https://github.com/johnfactotum/foliate-js" }
    ]
  },
  {
    groupKey: "faceRecognition",
    items: [
      { name: "InsightFace · buffalo (SCRFD + ArcFace r50)", use: "SCRFD-500MF face detector + ArcFace ResNet50 recognition", license: "Models: non-commercial / research use", url: "https://github.com/deepinsight/insightface" },
      { name: "ONNX Runtime", use: "Runs the face models on your server (onnxruntime-node)", license: "MIT", url: "https://onnxruntime.ai" }
    ]
  },
  {
    groupKey: "photosVideo",
    items: [
      { name: "sharp", use: "Image decoding, thumbnails & face crops", license: "Apache-2.0", url: "https://sharp.pixelplumbing.com" },
      { name: "exifr", use: "Reading photo EXIF / GPS metadata", license: "MIT", url: "https://github.com/MikeKovarik/exifr" },
      { name: "FFmpeg", use: "Video metadata & poster frames (ffmpeg-static / ffprobe-static)", license: "LGPL / GPL", url: "https://ffmpeg.org" },
      { name: "Leaflet", use: "The map view (+ marker clustering)", license: "BSD-2-Clause", url: "https://leafletjs.com" },
      { name: "OpenStreetMap", use: "Map tiles", license: "© OpenStreetMap contributors (ODbL)", url: "https://www.openstreetmap.org/copyright" }
    ]
  },
  {
    groupKey: "locations",
    items: [
      { name: "DB-IP Country Lite", use: "Which country a sign-in came from (read locally, never queried online)", license: "CC BY 4.0 — © DB-IP.com", url: "https://db-ip.com/db/download/ip-to-country-lite" },
      { name: "maxmind", use: "Reads the .mmdb database file", license: "MIT", url: "https://github.com/runk/node-maxmind" },
      { name: "svg-maps", use: "The world map outline on the Locations page", license: "CC BY 4.0", url: "https://github.com/VictorCazanave/svg-maps" }
    ]
  },
  {
    groupKey: "audiobooks",
    items: [
      { name: "music-metadata", use: "Audio tags, chapters & durations", license: "MIT", url: "https://github.com/borewit/music-metadata" }
    ]
  },
  {
    groupKey: "serverCore",
    items: [
      { name: "Fastify", use: "The web server + plugins (cookies, CORS, Helmet, uploads, rate-limiting, static)", license: "MIT", url: "https://fastify.dev" },
      { name: "better-sqlite3", use: "The SQLite database", license: "MIT", url: "https://github.com/WiseLibs/better-sqlite3" },
      { name: "Zod", use: "Request validation", license: "MIT", url: "https://zod.dev" },
      { name: "otplib", use: "Two-factor (TOTP) sign-in codes", license: "MIT", url: "https://github.com/yeojz/otplib" },
      { name: "node-qrcode", use: "2FA & reader-access QR codes", license: "MIT", url: "https://github.com/soldair/node-qrcode" },
      { name: "Nodemailer", use: "Email (alerts, send-to-e-reader)", license: "MIT-0", url: "https://nodemailer.com" },
      { name: "Archiver / adm-zip", use: "Backups", license: "MIT", url: "https://github.com/archiverjs/node-archiver" },
      { name: "undici", use: "HTTP client for metadata lookups", license: "MIT", url: "https://undici.nodejs.org" },
      { name: "nanoid", use: "Identifier generation", license: "MIT", url: "https://github.com/ai/nanoid" }
    ]
  },
  {
    groupKey: "app",
    items: [
      { name: "React", use: "The user interface", license: "MIT", url: "https://react.dev" },
      { name: "Vite", use: "Build & development tooling", license: "MIT", url: "https://vitejs.dev" },
      { name: "Lucide", use: "Interface icons (lucide-react)", license: "ISC", url: "https://lucide.dev" },
      { name: "idb", use: "Offline storage (IndexedDB)", license: "ISC", url: "https://github.com/jakearchibald/idb" }
    ]
  }
];

export function AboutCredits() {
  const { t } = useTranslation(["common", "misc"]);
  return (
    <section className="about-credits" aria-label={t("misc:about.creditsAria")}>
      <p className="about-credits-intro">
        {t("misc:about.creditsIntro")}
      </p>
      {CREDITS.map((section) => (
        <div className="about-credit-group" key={section.groupKey}>
          <h3 className="about-credit-group-title">{t(`misc:about.creditGroups.${section.groupKey}`)}</h3>
          <ul className="about-credit-list">
            {section.items.map((item) => (
              <li className="about-credit-item" key={item.name}>
                <a className="about-credit-name" href={item.url} target="_blank" rel="noreferrer">{item.name}</a>
                <span className="about-credit-use">{item.use}</span>
                <span className="about-credit-license">{item.license}</span>
              </li>
            ))}
          </ul>
        </div>
      ))}
    </section>
  );
}
