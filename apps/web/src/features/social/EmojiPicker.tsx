import { useEffect, useRef, useState } from "react";
import { Smile } from "lucide-react";
import { Button } from "../../shared/Button";

// A handful of emoji, one tap away.
//
// Emoji already worked in a note the day notes shipped — they are plain text,
// and the plain-text path carries them byte for byte. What was missing was
// somewhere to find them: on a phone the emoji keyboard is right there, but at a
// desk most people never think to reach for one.
//
// So this is a discovery aid, not a feature. Deliberately NOT a full picker with
// search and categories and a few thousand entries: this is a family library,
// and a short list of the ones people actually use beats a browser for all of
// Unicode. No dependency either — a picker library would be a lot of bytes and
// a CSP argument for something a grid of buttons does.
//
// A popover, not a modal: it never blocks the page and Escape gets rid of it.

const EMOJI = [
  "😀", "😂", "🥰", "😍", "🤩", "😢", "😮", "🤔",
  "👍", "👏", "🙌", "❤️", "💛", "✨", "🎉", "🔥",
  "👨‍👩‍👧", "👶", "🧓", "🐶", "🐱", "🎂", "🎄", "🌟",
  "📖", "📚", "🎧", "🎵", "🎬", "📷", "🗺️", "💯",
  "🏖️", "🏔️", "🌳", "☀️", "🌧️", "✈️", "🚗", "🍰"
];

export function EmojiPicker({ onPick, disabled }: { onPick: (emoji: string) => void; disabled?: boolean }) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);

  // Same dismissal contract as the app's other popovers (see shared/ActionMenu):
  // a click anywhere else, or Escape.
  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: MouseEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("mousedown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [open]);

  return (
    <div className="emoji-picker" ref={rootRef}>
      <Button
        variant="icon"
        compact
        title="Add an emoji"
        aria-label="Add an emoji"
        aria-haspopup="dialog"
        aria-expanded={open}
        disabled={disabled}
        onClick={() => setOpen((value) => !value)}
      >
        <Smile size={16} aria-hidden />
      </Button>

      {open && (
        <div className="emoji-popover" role="dialog" aria-label="Emoji">
          {EMOJI.map((emoji) => (
            <button
              key={emoji}
              type="button"
              className="emoji-option"
              // The emoji itself is the label — a screen reader announces its
              // Unicode name, which is better than anything to be invented here.
              aria-label={emoji}
              onClick={() => {
                onPick(emoji);
                setOpen(false);
              }}
            >
              {emoji}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
