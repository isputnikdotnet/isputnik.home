import packageInfo from "../../../../package.json";

// The version the running server reports too: both read the root package.json.
export const APP_VERSION: string = packageInfo.version;

// The release stage ("beta"), shown beside the version — kept out of the version
// string itself (see config.ts on the server). Absent once the app is stable.
export const APP_STAGE: string | null = (packageInfo as { stage?: string }).stage ?? null;

/** "v4.0.0 · Beta", or "v4.0.0" with no stage. Pass the server's values on the
 *  About page (it describes the running server); the defaults are this bundle's. */
export function versionLabel(
  t: (key: "releaseStage.beta") => string,
  version: string = APP_VERSION,
  stage: string | null = APP_STAGE
): string {
  const stageName = stage === "beta" ? t("releaseStage.beta") : stage;
  return stageName ? `v${version} · ${stageName}` : `v${version}`;
}
