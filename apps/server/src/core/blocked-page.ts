// What a blocked source address is told. API callers (and the app's own fetches)
// get the JSON they can render inline; a browser navigating here would otherwise
// paint that JSON as bare text on a white page, so it gets a small page instead.
// Everything is inline — every other request from a blocked address is refused
// too, so the page can't reference a stylesheet or an image and must carry its
// own. It deliberately says no more than the JSON does: not why, not for how
// long, not whether the block is manual — the audience is mostly scanners, and
// the one household member who ever sees it needs the "what now", not the case
// file (that lives in the admin's event log and email).

export function wantsHtml(headers: Record<string, unknown>): boolean {
  const accept = headers["accept"];
  return typeof accept === "string" && accept.includes("text/html");
}

export const BLOCKED_MESSAGE = "Your network has been blocked.";

export const BLOCKED_PAGE_HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Network blocked</title>
<style>
  :root { color-scheme: light dark; }
  body {
    margin: 0; min-height: 100vh; display: grid; place-items: center;
    font-family: system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
    background: #f4f4f5; color: #18181b;
  }
  main { max-width: 26rem; padding: 2.5rem 1.5rem; text-align: center; }
  .badge {
    width: 3.5rem; height: 3.5rem; margin: 0 auto 1.25rem; border-radius: 50%;
    display: grid; place-items: center; font-size: 1.6rem;
    background: #fee2e2; color: #b91c1c;
  }
  h1 { font-size: 1.25rem; margin: 0 0 0.75rem; }
  p { margin: 0 0 0.75rem; line-height: 1.55; color: #52525b; }
  footer { margin-top: 2rem; font-size: 0.8rem; color: #a1a1aa; }
  @media (prefers-color-scheme: dark) {
    body { background: #18181b; color: #fafafa; }
    .badge { background: #450a0a; color: #f87171; }
    p { color: #a1a1aa; }
    footer { color: #52525b; }
  }
</style>
</head>
<body>
<main>
  <div class="badge" aria-hidden="true">&#9888;</div>
  <h1>This network is blocked</h1>
  <p>The server has stopped answering your network address after repeated failed
  sign-ins or suspicious requests.</p>
  <p>Automatic blocks expire on their own after a cooldown. If you are a member
  of this household, try again later, switch to another network, or ask your
  administrator to unblock your address.</p>
  <footer>iSputnik &mdash; private family library</footer>
</main>
</body>
</html>
`;
