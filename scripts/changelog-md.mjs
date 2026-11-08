// Renders the in-app changelog (apps/server/src/changelog.json, the one source of
// truth) as Markdown.
//
//   node scripts/changelog-md.mjs                 writes CHANGELOG.md at the repo root and
//                                                 the <Date>/<Changes> of isputnik-home.xml
//   node scripts/changelog-md.mjs --version 4.0.0 prints that release's notes to stdout
//                                                 (docker.yml uses this for the
//                                                 GitHub Release of a tag)
//
// It reads the JSON directly. The server checks the file's shape as it loads it
// (apps/server/src/changelog.ts), so the test suite — which CI runs before any
// release job — has already refused a malformed entry by the time this renders it.

import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
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
  updateUnraidTemplate();
}

// The Unraid Community Applications template (isputnik-home.xml) carries the
// newest releases in <Changes> and the last release's time in <Date>; CA reads
// them from main to show the app's change log and its "last updated" date. Each
// release is dated by its v<version> tag, or today when it is not tagged yet
// (the release process runs this before tagging).
function updateUnraidTemplate() {
  const TEMPLATE = path.join(root, "isputnik-home.xml");
  const SHOWN = 5;
  const original = fs.readFileSync(TEMPLATE, "utf8");
  const eol = original.includes("\r\n") ? "\r\n" : "\n";
  const today = new Date().toISOString().slice(0, 10);
  const tagDate = (version) => {
    try {
      const out = execFileSync("git", ["log", "-1", "--format=%cs", `v${version}`], {
        cwd: root,
        stdio: ["ignore", "pipe", "ignore"]
      });
      return out.toString().trim() || today;
    } catch {
      return today;
    }
  };
  const xml = (text) => text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  const releases = VERSION_UPDATES.slice(0, SHOWN).map((update) => ({ ...update, date: tagDate(update.version) }));
  const changes = releases
    .map((update) =>
      [`### ${update.date.replace(/-/g, ".")} — ${update.version} ${update.label}`, ...update.changes.map((c) => `- ${c}`)].join(eol)
    )
    .join(eol + eol);
  const stamp = Math.floor(Date.parse(`${releases[0].date}T12:00:00Z`) / 1000);
  const block = [
    `  <Date>${stamp}</Date>`,
    `  <Changes>`,
    xml(changes),
    `  </Changes>`
  ].join(eol);

  let next = original.replace(/[ \t]*<Date>[^<]*<\/Date>\r?\n[ \t]*<Changes>[\s\S]*?<\/Changes>/, block);
  if (next === original && !original.includes("<Changes>")) {
    next = original.replace(/(<\/Overview>)/, `$1${eol}${eol}${block}`);
  }
  if (next !== original) fs.writeFileSync(TEMPLATE, next);
  console.log(`isputnik-home.xml: <Changes> for ${releases.map((r) => r.version).join(", ")}; <Date> ${releases[0].date}.`);
}
