// The folders the server can see, for the Browse button beside a System data folder.
//
// Separate from a storage container's browse route on purpose: backups belong on
// another disk, which is exactly the kind of place no container covers. Names of
// folders only, never files. Asynchronous throughout, because a sleeping disk or a
// lost network share must not stall every other request while someone looks at it.
import fs from "node:fs/promises";
import path from "node:path";

export interface ServerFolders {
  /** The folder being listed; null for the top: the drives and mapped folders. */
  path: string | null;
  /** One level up; "" is the top; null when already there. */
  parent: string | null;
  entries: { name: string; path: string }[];
}

// Filesystems that hold no one's files: the kernel's own, memory, and image layers.
const PSEUDO_FILESYSTEMS = new Set([
  "autofs", "binfmt_misc", "bpf", "cgroup", "cgroup2", "configfs", "debugfs", "devpts",
  "devtmpfs", "fusectl", "hugetlbfs", "mqueue", "nsfs", "overlay", "proc", "pstore",
  "ramfs", "rpc_pipefs", "securityfs", "squashfs", "sysfs", "tmpfs", "tracefs"
]);
const SYSTEM_MOUNTS = ["/proc", "/sys", "/dev", "/run", "/etc"];
const HIDDEN_AT_POSIX_ROOT = new Set(["proc", "sys", "dev"]);

/** The mount points in /proc/mounts worth offering. Docker volumes show up here, which
 *  is how a drive mapped into the container comes to be listed by its own path. */
export function mountPoints(procMounts: string): string[] {
  const found = new Set<string>();
  for (const line of procMounts.split("\n")) {
    const [, rawMount, type] = line.split(" ");
    if (!rawMount || !type || PSEUDO_FILESYSTEMS.has(type)) continue;
    // The file writes a space, tab, newline or backslash in a path as an octal escape.
    const mount = rawMount.replace(/\\([0-7]{3})/g, (_, code: string) => String.fromCharCode(parseInt(code, 8)));
    if (mount === "/" || SYSTEM_MOUNTS.some((root) => mount === root || mount.startsWith(`${root}/`))) continue;
    found.add(mount);
  }
  return [...found];
}

const isFolder = (target: string) => fs.stat(target).then((stat) => stat.isDirectory(), () => false);

async function topLevel(): Promise<string[]> {
  if (process.platform === "win32") {
    const letters = Array.from({ length: 26 }, (_, index) => `${String.fromCharCode(65 + index)}:\\`);
    const present = await Promise.all(letters.map(isFolder));
    return letters.filter((_, index) => present[index]);
  }
  const mounts = await fs.readFile("/proc/mounts", "utf8").then(mountPoints, () => []);
  // A mount can be a single file (Docker's /etc/hosts sort), hence the check.
  const present = await Promise.all(mounts.map(isFolder));
  return ["/", ...mounts.filter((_, index) => present[index]).sort((left, right) => left.localeCompare(right))];
}

function hidden(name: string, folder: string): boolean {
  if (process.platform === "win32") return name.startsWith("$") || name === "System Volume Information";
  return folder === "/" && HIDDEN_AT_POSIX_ROOT.has(name);
}

/** Lists one folder, or the top when `wanted` is empty. Throws when the path is not
 *  absolute or the folder can't be read. */
export async function listServerFolders(wanted: string): Promise<ServerFolders> {
  if (!wanted) {
    const places = await topLevel();
    return { path: null, parent: null, entries: places.map((place) => ({ name: place, path: place })) };
  }
  if (!path.isAbsolute(wanted)) throw new Error("Use an absolute server path.");
  const folder = path.resolve(wanted);
  const children = await fs.readdir(folder, { withFileTypes: true });
  const candidates = children.filter((entry) => !hidden(entry.name, folder) && (entry.isDirectory() || entry.isSymbolicLink()));
  const usable = await Promise.all(candidates.map((entry) => entry.isDirectory() || isFolder(path.join(folder, entry.name))));
  const entries = candidates
    .filter((_, index) => usable[index])
    .map((entry) => ({ name: entry.name, path: path.join(folder, entry.name) }))
    .sort((left, right) => left.name.localeCompare(right.name, undefined, { numeric: true }));
  return { path: folder, parent: path.dirname(folder) === folder ? "" : path.dirname(folder), entries };
}
