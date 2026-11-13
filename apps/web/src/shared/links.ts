// Canonical project URLs. Keep the GitHub org/repo in one place so links
// (bug reports, doc deep-links) can't drift across the app.
export const REPO_URL = "https://github.com/isputnikdotnet/isputnik.home";
export const REPO_ISSUES_URL = `${REPO_URL}/issues/new`;

// The ref this build came from: a tag like "v2.3.1" for a released image, "main"
// for a local build. Vite replaces __DOCS_REF__ at build time; the guard keeps
// this safe anywhere the define isn't applied.
export const DOCS_REF: string =
  typeof __DOCS_REF__ === "string" && __DOCS_REF__ ? __DOCS_REF__ : "main";

// Deep-link to a file in the repo, pinned to the version being run — a 2.1.0
// install should read 2.1.0's guides, not documentation for features it lacks.
export function repoFileUrl(path: string): string {
  return `${REPO_URL}/blob/${DOCS_REF}/${path}`;
}

/** GitHub Discussions: questions, help and ideas from the community. */
export const REPO_DISCUSSIONS_URL = `${REPO_URL}/discussions`;

/** The bug report form, with the version this app is running filled in — the one
 *  field every report needs and nobody remembers. Nothing else about the server or
 *  the person goes into the link. */
export function bugReportUrl(version: string): string {
  return `${REPO_URL}/issues/new?template=bug_report.yml&version=${encodeURIComponent(version)}`;
}

/** The feature request form. */
export const FEATURE_REQUEST_URL = `${REPO_URL}/issues/new?template=feature_request.yml`;
