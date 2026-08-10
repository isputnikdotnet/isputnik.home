// The house style for outgoing mail. Every message the server sends is described
// as a title plus a list of blocks, and this renders that description twice: once
// as HTML and once as plain text. One description, both renditions — so the text
// alternative can never drift from the HTML the way two hand-written bodies do.
//
// Constraints this is written against, which explain most of what looks dated:
//
//   • Tables, not flexbox. Outlook renders through Word, which has no support for
//     modern layout at all.
//   • Inline styles on every element. Gmail strips <style> from the head, so the
//     block below is progressive enhancement (dark mode) and nothing load-bearing
//     may live in it.
//   • A light card, never a dark one. Some clients drop background colours while
//     keeping text colours; light-on-dark degrades to white-on-white, whereas
//     dark-on-light degrades to something still readable.
//   • No remote images. They would need a tracking-shaped round trip to our host
//     and are blocked by default in most clients anyway, so the brand is type.

const BRAND = "isputnik.home";

// Accent is a darkened relative of the app's --mint (#9bbcaf), which is tuned for
// a dark UI and falls below contrast minimums on white.
const COLORS = {
  page: "#f1f0eb",
  card: "#ffffff",
  ink: "#14232a",
  muted: "#5f6b73",
  line: "#e3e1da",
  accent: "#2f6f66",
  codeBg: "#f4f7f6"
};

const FONT = "-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif";
const MONO = "ui-monospace, SFMono-Regular, Menlo, Consolas, 'Courier New', monospace";

export type EmailBlock =
  /** A paragraph. The workhorse. */
  | { kind: "text"; text: string }
  /** A one-time code: the whole point of the message it appears in. */
  | { kind: "code"; code: string; caption?: string }
  /** The thing the message is about — an item title, an album name. */
  | { kind: "subject"; text: string }
  /** Label/value pairs: source IP, when, which account. */
  | { kind: "facts"; rows: { label: string; value: string }[] }
  /** The one action, if there is one. */
  | { kind: "button"; label: string; url: string }
  /** Quieter than a paragraph — caveats, "if this wasn't you". */
  | { kind: "note"; text: string };

export interface EmailContent {
  /** The heading, and what the message is for. */
  title: string;
  /** The grey line clients show beside the subject. Falls back to the first text block. */
  preheader?: string;
  blocks: EmailBlock[];
  /** Replaces the default "sent by your iSputnik server" sign-off. */
  footnote?: string;
}

export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

// Only ever used on URLs we built ourselves, but a javascript: or data: href in a
// mail client is worth refusing on principle rather than on provenance. A rejected
// URL is dropped rather than shown: it cannot be an href, and printing it as text
// underneath the button would just put the thing we refused back on screen.
function isSafeUrl(url: string): boolean {
  return /^https?:\/\//i.test(url);
}

const p = (text: string, color: string, size = "15px", weight = "400") =>
  `<p style="margin:0 0 16px;font-family:${FONT};font-size:${size};font-weight:${weight};line-height:1.6;color:${color};">${escapeHtml(text)}</p>`;

function blockHtml(block: EmailBlock): string {
  switch (block.kind) {
    case "text":
      return p(block.text, COLORS.ink);

    case "note":
      return p(block.text, COLORS.muted, "13.5px");

    case "subject":
      return `
        <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="margin:0 0 18px;">
          <tr>
            <td class="panel" style="padding:13px 16px;border-left:3px solid ${COLORS.accent};background-color:${COLORS.codeBg};">
              <span class="ink" style="font-family:${FONT};font-size:16px;font-weight:600;line-height:1.4;color:${COLORS.ink};">${escapeHtml(block.text)}</span>
            </td>
          </tr>
        </table>`;

    case "code":
      // One unbroken text node: the code has to survive a double-click and a
      // drag. Anything that splits the digits into separate cells to space them
      // out copies back with the separators in it, which is how a code someone
      // pasted "correctly" gets rejected. letter-spacing does the spacing, and
      // the matching text-indent keeps it optically centred despite the trailing
      // gap letter-spacing adds after the final character.
      return `
        <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="margin:4px 0 18px;">
          <tr>
            <td align="center" bgcolor="${COLORS.codeBg}" class="panel" style="padding:22px 16px;background-color:${COLORS.codeBg};border:1px solid ${COLORS.line};border-radius:10px;">
              <span class="code ink" style="font-family:${MONO};font-size:38px;font-weight:700;line-height:1.15;letter-spacing:8px;text-indent:8px;color:${COLORS.ink};white-space:nowrap;">${escapeHtml(block.code)}</span>
              ${block.caption
                ? `<div class="muted" style="margin-top:10px;font-family:${FONT};font-size:13px;line-height:1.5;color:${COLORS.muted};">${escapeHtml(block.caption)}</div>`
                : ""}
            </td>
          </tr>
        </table>`;

    case "facts":
      return `
        <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" class="rule" style="margin:0 0 18px;border-top:1px solid ${COLORS.line};">
          ${block.rows.map((row) => `
          <tr>
            <td class="rule muted" style="padding:9px 12px 9px 0;border-bottom:1px solid ${COLORS.line};font-family:${FONT};font-size:13px;line-height:1.4;color:${COLORS.muted};white-space:nowrap;vertical-align:top;">${escapeHtml(row.label)}</td>
            <td class="rule ink" style="padding:9px 0;border-bottom:1px solid ${COLORS.line};font-family:${FONT};font-size:13px;line-height:1.4;color:${COLORS.ink};word-break:break-word;">${escapeHtml(row.value)}</td>
          </tr>`).join("")}
        </table>`;

    case "button":
      if (!isSafeUrl(block.url)) return p(block.label, COLORS.ink);
      // The URL is spelled out under the button as well. Buttons are the first
      // thing a cautious client strips, and a bare label with nothing behind it
      // is a dead end.
      return `
        <table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin:2px 0 20px;">
          <tr>
            <td bgcolor="${COLORS.accent}" style="border-radius:8px;background-color:${COLORS.accent};">
              <a href="${escapeHtml(block.url)}" style="display:inline-block;padding:12px 22px;font-family:${FONT};font-size:15px;font-weight:600;line-height:1;color:#ffffff;text-decoration:none;">${escapeHtml(block.label)}</a>
            </td>
          </tr>
        </table>
        <p class="muted" style="margin:-10px 0 18px;font-family:${FONT};font-size:12.5px;line-height:1.5;color:${COLORS.muted};word-break:break-all;">${escapeHtml(block.url)}</p>`;
  }
}

function blockText(block: EmailBlock): string[] {
  switch (block.kind) {
    case "text":
    case "note":
      return [block.text, ""];
    case "subject":
      return [`  ${block.text}`, ""];
    case "code":
      return block.caption ? [`  ${block.code}`, "", block.caption, ""] : [`  ${block.code}`, ""];
    case "facts":
      return [...block.rows.map((row) => `${row.label}: ${row.value}`), ""];
    case "button":
      return isSafeUrl(block.url) ? [`${block.label}: ${block.url}`, ""] : [block.label, ""];
  }
}

const DEFAULT_FOOTNOTE = `Sent by your ${BRAND} server.`;

export function renderEmail(content: EmailContent): { html: string; text: string } {
  const footnote = content.footnote ?? DEFAULT_FOOTNOTE;
  const firstText = content.blocks.find((block) => block.kind === "text" || block.kind === "note");
  const preheader = content.preheader
    ?? (firstText && "text" in firstText ? firstText.text : content.title);

  const text = [
    content.title,
    "",
    ...content.blocks.flatMap(blockText),
    "—",
    footnote
  ].join("\n").replace(/\n{3,}/g, "\n\n");

  const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="color-scheme" content="light dark">
<meta name="supported-color-schemes" content="light dark">
<title>${escapeHtml(content.title)}</title>
<style>
  /* Progressive enhancement only — Gmail drops this entirely, which is why every
     element above also carries the light styling inline. */
  @media (prefers-color-scheme: dark) {
    .cardbg { background-color: #10222a !important; }
    .pagebg { background-color: #071318 !important; }
    .ink, .ink * { color: #eef0ec !important; }
    .muted, .muted * { color: #9aa7ae !important; }
    .panel { background-color: #16303a !important; border-color: #22414c !important; }
    .rule { border-color: #22414c !important; }
  }
  @media only screen and (max-width: 620px) {
    .wrap { width: 100% !important; }
    .pad { padding-left: 22px !important; padding-right: 22px !important; }
    .code { font-size: 30px !important; letter-spacing: 5px !important; }
  }
</style>
</head>
<body class="pagebg" style="margin:0;padding:0;background-color:${COLORS.page};">
<div style="display:none;max-height:0;overflow:hidden;opacity:0;mso-hide:all;">${escapeHtml(preheader)}</div>
<table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" class="pagebg" style="background-color:${COLORS.page};">
  <tr>
    <td align="center" style="padding:32px 14px;">
      <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="600" class="wrap cardbg" style="width:600px;max-width:600px;background-color:${COLORS.card};border-radius:14px;overflow:hidden;">
        <tr>
          <td bgcolor="${COLORS.accent}" style="height:4px;line-height:4px;font-size:0;background-color:${COLORS.accent};">&nbsp;</td>
        </tr>
        <tr>
          <td class="pad" style="padding:26px 38px 0;">
            <span style="font-family:${FONT};font-size:12px;font-weight:700;letter-spacing:1.6px;text-transform:uppercase;color:${COLORS.accent};">${escapeHtml(BRAND)}</span>
          </td>
        </tr>
        <tr>
          <td class="pad ink" style="padding:14px 38px 0;">
            <h1 style="margin:0 0 18px;font-family:${FONT};font-size:22px;font-weight:700;line-height:1.3;color:${COLORS.ink};">${escapeHtml(content.title)}</h1>
          </td>
        </tr>
        <tr>
          <td class="pad ink" style="padding:0 38px;">
            ${content.blocks.map(blockHtml).join("\n")}
          </td>
        </tr>
        <tr>
          <td class="pad" style="padding:8px 38px 30px;">
            <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" class="rule" style="border-top:1px solid ${COLORS.line};">
              <tr>
                <td class="muted" style="padding-top:16px;font-family:${FONT};font-size:12.5px;line-height:1.6;color:${COLORS.muted};">${escapeHtml(footnote)}</td>
              </tr>
            </table>
          </td>
        </tr>
      </table>
    </td>
  </tr>
</table>
</body>
</html>`;

  return { html, text };
}
