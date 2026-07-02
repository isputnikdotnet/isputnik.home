// Docker prod-deps prune: remove every top-level node_modules package that is
// not in the transitive closure of apps/server's PRODUCTION dependencies.
//
// Why not `npm query ":extraneous, .dev"`: npm's flags are computed per hoisted
// tree node, so a package reachable through BOTH a dev tool and a runtime dep
// (sharp's detect-libc/semver, for example) can carry the dev flag — deleting
// by that list shipped a 1.8.0 image whose server crashed at import time.
//
// This closure is computed from package-lock.json by NAME over dependencies +
// optionalDependencies + peerDependencies edges of every lock entry for that
// name. Name-level union is an over-approximation: it can only KEEP a package
// that strictly wasn't needed, never delete one that is.
import fs from "node:fs";

// Destructive by design — only meant for the Docker build stage, whose context
// has no .git. Refuse to prune a real working checkout.
if (fs.existsSync(".git")) {
  console.error("refusing to prune: this looks like a git checkout, not a Docker build stage");
  process.exit(1);
}

const lock = JSON.parse(fs.readFileSync("package-lock.json", "utf8"));

// Every lock entry for a package name, wherever it is nested/hoisted.
const byName = new Map();
for (const [path, info] of Object.entries(lock.packages)) {
  const m = path.match(/node_modules\/((?:@[^/]+\/)?[^/]+)$/);
  if (!m) continue;
  const list = byName.get(m[1]) ?? [];
  list.push(info);
  byName.set(m[1], list);
}

const server = lock.packages["apps/server"];
if (!server) throw new Error("apps/server workspace not found in package-lock.json");

const keep = new Set();
const queue = Object.keys({ ...server.dependencies, ...server.optionalDependencies });
while (queue.length > 0) {
  const name = queue.pop();
  if (keep.has(name)) continue;
  keep.add(name);
  for (const info of byName.get(name) ?? []) {
    queue.push(...Object.keys({
      ...info.dependencies, ...info.optionalDependencies, ...info.peerDependencies
    }));
  }
}

let removed = 0;
const pruneDir = (dir, scope) => {
  for (const entry of fs.readdirSync(dir)) {
    if (entry.startsWith(".")) continue; // .bin, .package-lock.json
    if (entry.startsWith("@") && !scope) { pruneDir(`${dir}/${entry}`, entry); continue; }
    const name = scope ? `${scope}/${entry}` : entry;
    if (name.startsWith("@isputnik/")) continue; // workspace links
    if (!keep.has(name)) {
      fs.rmSync(`${dir}/${entry}`, { recursive: true, force: true });
      removed += 1;
    }
  }
};
pruneDir("node_modules", "");

console.log(`pruned ${removed} non-runtime packages; runtime closure holds ${keep.size} names`);
