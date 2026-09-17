import { controlHref } from "../../router";

// Addresses that land on a control page already narrowed to what you were looking
// at — a scan's library on Tasks, a cleanup's removals in the Recycle Bin, an
// address on Logs. Each page reads its own parameters on arrival (and Tasks keeps
// them in step as you change its filters), so these are ordinary links: Back,
// a new tab and a pasted address all work. Sign-ins has its own, signInsHref, next
// to the page that owns the dive.

function withQuery(path: string, params: Record<string, string | undefined>): string {
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value) query.set(key, value);
  }
  const suffix = query.toString();
  return suffix ? `${path}?${suffix}` : path;
}

/** Maintenance › Tasks, filtered. `library` is a library id, `type` a job type. */
export function tasksHref(filters: { library?: string; status?: "failed" | "completed"; type?: string } = {}): string {
  return withQuery(controlHref("tasks"), filters);
}

/** Maintenance › Recycle Bin, filtered. `source` is how an item was removed ("duplicate_cleanup"). */
export function recycleBinHref(filters: { library?: string; source?: string } = {}): string {
  return withQuery(controlHref("recycleBin"), filters);
}

/** Overview › Logs, filtered to one address or one person. `user` is an account id. */
export function logsHref(filters: { ip?: string; user?: string } = {}): string {
  return withQuery(controlHref("logs"), filters);
}

/** Security › Blocked IPs with the Block dialog open for `ip`. */
export function blockIpHref(ip: string): string {
  return withQuery(controlHref("securityBlocked"), { block: ip });
}

/** Library › Libraries, scrolled to one library's row. */
export function libraryRowHref(libraryId: string): string {
  return `${controlHref("libraries")}#library-${libraryId}`;
}

/** Library › Storage, scrolled to one of its cards. */
export function storageHref(card?: "storage-containers" | "system-data" | "app-storage"): string {
  return card ? `${controlHref("storage")}#${card}` : controlHref("storage");
}

/** A page's query parameter as it was on arrival, or "" — for seeding filter state. */
export function initialParam(name: string): string {
  return new URLSearchParams(window.location.search).get(name) ?? "";
}
