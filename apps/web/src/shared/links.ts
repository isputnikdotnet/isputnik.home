// Canonical project URLs. Keep the GitHub org/repo in one place so links
// (bug reports, doc deep-links) can't drift across the app.
export const REPO_URL = "https://github.com/isputnikdotnet/isputnik.home";
export const REPO_ISSUES_URL = `${REPO_URL}/issues/new`;

// Deep-link to a file in the repo on the default branch (e.g. a docs/ guide).
export function repoFileUrl(path: string): string {
  return `${REPO_URL}/blob/main/${path}`;
}
