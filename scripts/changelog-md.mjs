// Renders the in-app changelog (apps/server/src/changelog.json, the one source of
// truth) as Markdown.
//
//   node scripts/changelog-md.mjs                 writes CHANGELOG.md at the repo root
//   node scripts/changelog-md.mjs --version 4.0.0 prints that release's notes to stdout
//                                                 (docker.yml uses this for the
//                                                 GitHub Release of a tag)
//
// It reads the JSON directly. The server checks the file's shape as it loads it
// (apps/server/src/changelog.ts), so the test suite — which CI runs before any
// release job — has already refused a malformed entry by the time this renders it.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SOURCE = "apps/server/src/changelog.json";
const VERSION_UPDATES = JSON.parse(fs.readFileSync(path.join(root, SOURCE), "utf8"));

function renderRelease(update) {
  return [`## ${update.version} — ${update.label}`, "", ...update.changes.map((change) => `- ${change}`), ""].join("\n");
}

const flag = process.argv.indexOf("--version");
if (flag !== -1) {
  const wanted = (process.argv[flag + 1] ?? "").replace(/^v/, "");
  const update = VERSION_UPDATES.find((entry) => entry.version === wanted);
  if (!update) {
    console.error(`No changelog entry for version "${wanted}" in ${SOURCE}.`);
    process.exit(1);
  }
  // The release page already carries the version as its title.
  process.stdout.write([`**${update.label}**`, "", ...update.changes.map((change) => `- ${change}`), ""].join("\n"));
} else {
  const header = [
    "# Changelog",
    "",
    `Every release, newest first. Generated from \`${SOURCE}\` (the same`,
    "text the app shows on its About page) by `npm run changelog` — edit that file, not this one.",
    ""
  ].join("\n");
  const body = VERSION_UPDATES.map(renderRelease).join("\n");
  fs.writeFileSync(path.join(root, "CHANGELOG.md"), `${header}\n${body}`);
  console.log(`CHANGELOG.md: ${VERSION_UPDATES.length} releases.`);
}
