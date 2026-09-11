// Renders the in-app changelog (apps/server/src/changelog.ts, the one source of
// truth) as Markdown.
//
//   node scripts/changelog-md.mjs                 writes CHANGELOG.md at the repo root
//   node scripts/changelog-md.mjs --version 4.0.0 prints that release's notes to stdout
//                                                 (docker.yml uses this for the
//                                                 GitHub Release of a tag)
//
// changelog.ts is plain data with erasable type annotations, so Node imports it
// directly (type stripping is on by default from Node 23.6; the repo needs 24+).

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const { VERSION_UPDATES } = await import(pathToFileURL(path.join(root, "apps/server/src/changelog.ts")).href);

function renderRelease(update) {
  return [`## ${update.version} — ${update.label}`, "", ...update.changes.map((change) => `- ${change}`), ""].join("\n");
}

const flag = process.argv.indexOf("--version");
if (flag !== -1) {
  const wanted = (process.argv[flag + 1] ?? "").replace(/^v/, "");
  const update = VERSION_UPDATES.find((entry) => entry.version === wanted);
  if (!update) {
    console.error(`No changelog entry for version "${wanted}" in apps/server/src/changelog.ts.`);
    process.exit(1);
  }
  // The release page already carries the version as its title.
  process.stdout.write([`**${update.label}**`, "", ...update.changes.map((change) => `- ${change}`), ""].join("\n"));
} else {
  const header = [
    "# Changelog",
    "",
    "Every release, newest first. Generated from `apps/server/src/changelog.ts` (the same",
    "text the app shows on its About page) by `npm run changelog` — edit that file, not this one.",
    ""
  ].join("\n");
  const body = VERSION_UPDATES.map(renderRelease).join("\n");
  fs.writeFileSync(path.join(root, "CHANGELOG.md"), `${header}\n${body}`);
  console.log(`CHANGELOG.md: ${VERSION_UPDATES.length} releases.`);
}
