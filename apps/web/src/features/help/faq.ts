// The Help page's frequently asked questions, read from docs/users/faq.md.
//
// Each "## " heading is a question and the markdown under it is the answer. A
// question only administrators need carries an `<!-- admin -->` line directly
// under its heading. The answers stay short and link into the guide section that
// says it properly; `check:ui` fails when one of those links points at a guide or
// heading that doesn't exist.

export interface FaqEntry {
  question: string;
  answer: string;
  adminOnly: boolean;
}

export function parseFaq(markdown: string): FaqEntry[] {
  const entries: FaqEntry[] = [];
  let current: { question: string; lines: string[] } | null = null;

  const flush = () => {
    if (!current) return;
    const lines = [...current.lines];
    while (lines.length && !lines[0].trim()) lines.shift();
    const adminOnly = /^\s*<!--\s*admin\s*-->\s*$/i.test(lines[0] ?? "");
    if (adminOnly) lines.shift();
    const answer = lines.join("\n").trim();
    if (answer) entries.push({ question: current.question, answer, adminOnly });
  };

  for (const line of markdown.split(/\r?\n/)) {
    const heading = /^##\s+(.+?)\s*$/.exec(line);
    if (heading) {
      flush();
      current = { question: heading[1], lines: [] };
    } else if (current) {
      current.lines.push(line);
    }
  }
  flush();
  return entries;
}
