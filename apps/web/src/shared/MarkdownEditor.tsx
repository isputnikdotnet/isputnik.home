import { useRef, type KeyboardEvent, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { Bold, Heading2, Italic, Link2, List, ListOrdered, Quote } from "lucide-react";

// A plain textarea with a row of buttons over it. Deliberately not a
// what-you-see-is-what-you-get editor: story text is stored as markdown and
// rendered by StoryMarkdown's tight allowlist, and a WYSIWYG would mean
// converting HTML back to markdown on every keystroke to keep that guarantee.
// The buttons write the same marks a person could type — the field is still
// text, and somebody who knows markdown can ignore the row entirely.
//
// Every action wraps or prefixes the SELECTION, restores it afterwards, and
// leaves the cursor where you would want to keep typing. Ctrl/Cmd+B, I and K
// do the three that have muscle memory.

type Wrap = { before: string; after: string };
type Prefix = { prefix: string; ordered?: boolean };

/** Apply a mark to `value` over [start, end), returning the new text and where
 *  the selection should sit afterwards. Pure, so it is the part worth testing. */
export function applyMark(
  value: string,
  start: number,
  end: number,
  mark: Wrap | Prefix
): { value: string; start: number; end: number } {
  const selected = value.slice(start, end);

  if ("prefix" in mark) {
    // Line marks act on whole lines: from the start of the first selected line
    // to the end of the last, so a half-selected line still gets its bullet.
    const from = value.lastIndexOf("\n", start - 1) + 1;
    const toIndex = value.indexOf("\n", end);
    const to = toIndex === -1 ? value.length : toIndex;
    const lines = value.slice(from, to).split("\n");
    const marked = lines.every((line) => hasPrefix(line, mark));
    const next = lines
      .map((line, index) => (marked
        ? stripPrefix(line, mark)
        : `${mark.ordered ? `${index + 1}. ` : mark.prefix}${line}`))
      .join("\n");
    return { value: value.slice(0, from) + next + value.slice(to), start: from, end: from + next.length };
  }

  // Already wrapped? Take the marks off again — the buttons toggle, which is
  // what pressing Ctrl+B twice has always meant.
  const outer = value.slice(start - mark.before.length, end + mark.after.length);
  if (selected && outer === `${mark.before}${selected}${mark.after}`) {
    return {
      value: value.slice(0, start - mark.before.length) + selected + value.slice(end + mark.after.length),
      start: start - mark.before.length,
      end: end - mark.before.length
    };
  }

  const next = value.slice(0, start) + mark.before + selected + mark.after + value.slice(end);
  return {
    value: next,
    // Nothing selected: park the cursor between the marks, ready to type.
    start: start + mark.before.length,
    end: start + mark.before.length + selected.length
  };
}

function hasPrefix(line: string, mark: Prefix): boolean {
  return mark.ordered ? /^\d+\.\s/.test(line) : line.startsWith(mark.prefix);
}

function stripPrefix(line: string, mark: Prefix): string {
  return mark.ordered ? line.replace(/^\d+\.\s/, "") : line.slice(mark.prefix.length);
}

export function MarkdownEditor({
  value,
  onChange,
  onBlur,
  placeholder,
  rows = 8,
  maxLength,
  ariaLabel,
  autoFocus = false
}: {
  value: string;
  onChange: (value: string) => void;
  onBlur?: () => void;
  placeholder?: string;
  rows?: number;
  maxLength?: number;
  ariaLabel?: string;
  autoFocus?: boolean;
}) {
  const { t } = useTranslation(["common"]);
  const ref = useRef<HTMLTextAreaElement>(null);

  const apply = (mark: Wrap | Prefix) => {
    const field = ref.current;
    if (!field) return;
    const result = applyMark(value, field.selectionStart, field.selectionEnd, mark);
    onChange(result.value);
    // After React has written the new value, put the selection back — typing
    // should carry on from inside the marks, not from the end of the field.
    requestAnimationFrame(() => {
      field.focus();
      field.setSelectionRange(result.start, result.end);
    });
  };

  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (!(event.metaKey || event.ctrlKey)) return;
    const key = event.key.toLowerCase();
    const mark = key === "b" ? MARKS.bold : key === "i" ? MARKS.italic : key === "k" ? MARKS.link : null;
    if (!mark) return;
    event.preventDefault();
    apply(mark);
  };

  const button = (key: string, label: string, icon: ReactNode, mark: Wrap | Prefix) => (
    <button
      key={key}
      type="button"
      className="markdown-tool"
      title={label}
      aria-label={label}
      // mousedown, not click: a click would blur the field first, and the
      // block's own "save on blur" would fire mid-edit.
      onMouseDown={(event) => { event.preventDefault(); apply(mark); }}
    >
      {icon}
    </button>
  );

  return (
    <div className="markdown-editor">
      <div className="markdown-tools" role="toolbar" aria-label={t("markdown.toolbar")}>
        {button("bold", t("markdown.bold"), <Bold size={15} aria-hidden="true" />, MARKS.bold)}
        {button("italic", t("markdown.italic"), <Italic size={15} aria-hidden="true" />, MARKS.italic)}
        {button("heading", t("markdown.heading"), <Heading2 size={15} aria-hidden="true" />, MARKS.heading)}
        <span className="markdown-tools-gap" aria-hidden="true" />
        {button("bullet", t("markdown.bulletList"), <List size={15} aria-hidden="true" />, MARKS.bullet)}
        {button("number", t("markdown.numberList"), <ListOrdered size={15} aria-hidden="true" />, MARKS.number)}
        {button("quote", t("markdown.quote"), <Quote size={15} aria-hidden="true" />, MARKS.quote)}
        {button("link", t("markdown.link"), <Link2 size={15} aria-hidden="true" />, MARKS.link)}
      </div>

      <textarea
        ref={ref}
        className="story-text-input"
        value={value}
        onChange={(event) => onChange(event.target.value)}
        onBlur={onBlur}
        onKeyDown={onKeyDown}
        placeholder={placeholder}
        rows={rows}
        maxLength={maxLength}
        aria-label={ariaLabel}
        autoFocus={autoFocus}
      />
    </div>
  );
}

const MARKS = {
  bold: { before: "**", after: "**" },
  italic: { before: "*", after: "*" },
  // A story's own title is the page's h1, so the biggest heading inside one is
  // an h2 — the same level StoryMarkdown's readers already see.
  heading: { prefix: "## " },
  bullet: { prefix: "- " },
  number: { prefix: "1. ", ordered: true },
  quote: { prefix: "> " },
  link: { before: "[", after: "](https://)" }
} satisfies Record<string, Wrap | Prefix>;
