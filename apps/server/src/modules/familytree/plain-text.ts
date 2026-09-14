// A biography is written as markdown (the person editor's Bio tab uses the same
// editor as story text), but GEDCOM's NOTE is plain text: another genealogy
// program would show `**Minsk**` with its asterisks. This takes the marks off and
// keeps the words, the line breaks, and list lines as they read in plain text
// ("- item", "1. item"). A link keeps its address beside its words.
//
// Deliberately small: it undoes what shared/MarkdownEditor's buttons write (bold,
// italic, heading, lists, quote, link) plus strikethrough and inline code. Text
// that was never markdown — an imported note — comes out unchanged, except for a
// backslash-escaped mark, which loses its backslash as a renderer would.

export function markdownToPlainText(markdown: string): string {
  return markdown
    .split("\n")
    .map((line) => line
      .replace(/^\s{0,3}#{1,6}\s+/, "")
      .replace(/^\s{0,3}>\s?/, ""))
    .join("\n")
    // [words](https://…) → words (https://…); a link whose words ARE the address stays one.
    .replace(/\[([^\]\n]+)\]\(([^)\s]+)\)/g, (_, text: string, url: string) => (text === url ? url : `${text} (${url})`))
    .replace(/(\*\*|__)(?=\S)([^\n]*?\S)\1/g, "$2")
    .replace(/~~(?=\S)([^\n]*?\S)~~/g, "$1")
    // Single * or _ only when it hugs words on both inner sides and is not part of
    // a word itself (snake_case, 2*3*4 stay as written).
    .replace(/(^|[^\w*\\])\*(?=\S)([^*\n]*?\S)\*(?![\w*])/g, "$1$2")
    .replace(/(^|[^\w\\])_(?=\S)([^_\n]*?\S)_(?!\w)/g, "$1$2")
    .replace(/`([^`\n]+)`/g, "$1")
    .replace(/\\([\\`*_[\]#>~-])/g, "$1");
}
