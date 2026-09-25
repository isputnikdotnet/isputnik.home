// An uploaded package waiting for the admin's go-ahead. The import runs twice:
// the upload is read and PLANNED (nothing written) and the preview goes back with
// a token; the admin decides per person and confirms with the same token; only
// then is the plan written. The zip stays on disk under the data folder until
// then — memory would not do for a package of photos — and is dropped after an
// hour, or when the server starts (a half-done import is not resumed).
import fs from "node:fs";
import path from "node:path";
import { nanoid } from "nanoid";
import type { FastifyRequest } from "fastify";
import { config } from "../../../config.js";
import { receiveUpload, UploadError } from "../../uploads/index.js";
import { readZipEntryText } from "../../backups/zip-read.js";
import {
  MANIFEST_ENTRY, PACKAGE_FORMAT_VERSION, TREE_ENTRY, packageManifestSchema, packageTreeSchema,
  type PackageManifest, type PackageTree
} from "./format.js";

const PENDING_TTL_MS = 60 * 60 * 1000;
/** tree.json for a very large tree is a few MB; this is far above that. */
const MAX_TREE_JSON_BYTES = 256 * 1024 * 1024;

export interface PendingImport {
  token: string;
  packagePath: string;
  stagingDir: string;
  manifest: PackageManifest;
  tree: PackageTree;
  userId: string;
  createdAt: number;
}

export class PackageError extends Error {
  constructor(message: string, readonly statusCode: number) {
    super(message);
  }
}

const pending = new Map<string, PendingImport>();

/** Where uploads wait: in the data folder beside the database, never inside a
 *  library. Absolute, so an in-memory database (tests) still lands somewhere
 *  definite — under the working directory's data folder. */
export function importsDir(): string {
  const dataDir = config.dbPath === ":memory:" ? path.join(process.cwd(), "data") : path.dirname(path.dirname(config.dbPath));
  return path.resolve(dataDir, "tmp", "family-tree-imports");
}

/** Forget every pending import and its files — at startup, and in tests. */
export function sweepPendingImports(): void {
  for (const entry of pending.values()) removeFiles(entry);
  pending.clear();
  fs.rmSync(importsDir(), { recursive: true, force: true });
}

function removeFiles(entry: PendingImport): void {
  fs.rmSync(entry.packagePath, { force: true });
  fs.rmSync(entry.stagingDir, { recursive: true, force: true });
}

function expire(): void {
  const cutoff = Date.now() - PENDING_TTL_MS;
  for (const [token, entry] of pending) {
    if (entry.createdAt < cutoff) { removeFiles(entry); pending.delete(token); }
  }
}

/** Read and check a package zip that is already on disk. Throws PackageError
 *  with a message for the admin when it is not a package this server can read. */
export async function readPackage(packagePath: string): Promise<{ manifest: PackageManifest; tree: PackageTree }> {
  let manifestText: string | null;
  let treeText: string | null;
  try {
    manifestText = await readZipEntryText(packagePath, (name) => name === MANIFEST_ENTRY);
    treeText = manifestText ? await readZipEntryText(packagePath, (name) => name === TREE_ENTRY, MAX_TREE_JSON_BYTES) : null;
  } catch {
    throw new PackageError("This file is not a zip archive this server can open.", 400);
  }
  if (!manifestText) throw new PackageError("This zip is not a family-tree package: it has no manifest.json.", 400);
  let manifestJson: unknown;
  try { manifestJson = JSON.parse(manifestText); } catch { throw new PackageError("The package's manifest could not be read.", 400); }
  const manifest = packageManifestSchema.safeParse(manifestJson);
  if (!manifest.success) throw new PackageError("This zip is not a family-tree package.", 400);
  if (manifest.data.formatVersion > PACKAGE_FORMAT_VERSION) {
    throw new PackageError("This package was made by a newer version. Update this server first.", 400);
  }
  if (!treeText) throw new PackageError("The package has no tree.json.", 400);
  let treeJson: unknown;
  try { treeJson = JSON.parse(treeText); } catch { throw new PackageError("The package's tree.json could not be read.", 400); }
  const tree = packageTreeSchema.safeParse(treeJson);
  if (!tree.success) throw new PackageError("The package's tree.json is not in a shape this server understands.", 400);
  return { manifest: manifest.data, tree: tree.data };
}

/** Take the uploaded zip, read it, and keep it for the confirming call. */
export async function receivePackage(request: FastifyRequest, userId: string): Promise<PendingImport> {
  expire();
  const dir = importsDir();
  fs.mkdirSync(dir, { recursive: true });
  let received;
  try {
    received = await receiveUpload(request, { accept: ["zip"], maxBytes: null }, dir);
  } catch (err) {
    throw new PackageError(err instanceof Error ? err.message : "Upload failed.", err instanceof UploadError ? err.statusCode : 400);
  }
  const token = nanoid(24);
  const packagePath = path.join(dir, `${token}.zip`);
  fs.renameSync(received.tmpPath, packagePath);
  try {
    const { manifest, tree } = await readPackage(packagePath);
    const entry: PendingImport = {
      token, packagePath, stagingDir: path.join(dir, `${token}-media`), manifest, tree, userId, createdAt: Date.now()
    };
    pending.set(token, entry);
    return entry;
  } catch (err) {
    fs.rmSync(packagePath, { force: true });
    throw err;
  }
}

/** The pending import for a token, for the admin who uploaded it. */
export function getPendingImport(token: string, userId: string): PendingImport | null {
  expire();
  const entry = pending.get(token);
  return entry && entry.userId === userId ? entry : null;
}

export function discardPendingImport(token: string): void {
  const entry = pending.get(token);
  if (!entry) return;
  removeFiles(entry);
  pending.delete(token);
}
