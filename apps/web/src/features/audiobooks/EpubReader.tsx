import { useEffect, useRef, useState } from "react";
import { ChevronLeft, ChevronRight } from "lucide-react";
import ePub, { type Book, type Rendition } from "epubjs";

// In-browser EPUB reader (epub.js). Fetches the file with credentials so the
// auth-gated document endpoint works, then paginates it inside the overlay.
export function EpubReader({ url }: { url: string }) {
  const containerRef = useRef<HTMLDivElement>(null);
  const renditionRef = useRef<Rendition | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  useEffect(() => {
    let cancelled = false;
    let book: Book | null = null;

    (async () => {
      try {
        const res = await fetch(url, { credentials: "include" });
        if (!res.ok) throw new Error("Could not load this ebook.");
        const buffer = await res.arrayBuffer();
        if (cancelled || !containerRef.current) return;

        book = ePub(buffer);
        const rendition = book.renderTo(containerRef.current, {
          width: "100%",
          height: "100%",
          flow: "paginated",
          spread: "auto"
        });
        // Light "paper" background so content stays readable over the dark overlay.
        rendition.themes.default({ body: { background: "#fbfbf6", color: "#1a1a1a" } });
        renditionRef.current = rendition;
        await rendition.display();
        if (!cancelled) setLoading(false);
      } catch (err) {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : "Could not load this ebook.");
          setLoading(false);
        }
      }
    })();

    return () => {
      cancelled = true;
      try { renditionRef.current?.destroy(); } catch { /* ignore */ }
      try { book?.destroy(); } catch { /* ignore */ }
      renditionRef.current = null;
    };
  }, [url]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "ArrowLeft") void renditionRef.current?.prev();
      if (e.key === "ArrowRight") void renditionRef.current?.next();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  if (error) {
    return <div className="epub-reader-status">{error}</div>;
  }

  return (
    <div className="epub-reader">
      <button className="epub-nav" onClick={() => void renditionRef.current?.prev()} aria-label="Previous page">
        <ChevronLeft size={28} />
      </button>
      <div className="epub-reader-area" ref={containerRef}>
        {loading && <div className="epub-reader-status">Loading…</div>}
      </div>
      <button className="epub-nav" onClick={() => void renditionRef.current?.next()} aria-label="Next page">
        <ChevronRight size={28} />
      </button>
    </div>
  );
}
