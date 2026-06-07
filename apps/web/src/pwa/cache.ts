const PRIVATE_RUNTIME_CACHES = ["isputnik-catalog", "isputnik-covers"];

export async function clearPrivateRuntimeCaches(): Promise<void> {
  if (!("caches" in window)) return;
  await Promise.all(PRIVATE_RUNTIME_CACHES.map((name) => window.caches.delete(name)));
}
