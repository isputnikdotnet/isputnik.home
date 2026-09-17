import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { ChevronDown } from "lucide-react";
import { Button } from "../../shared/Button";
import { cx } from "../../shared/cx";
import { followGuideLink, renderGuideHtml } from "../../pages/GuidePage";
import { parseFaq, type FaqEntry } from "./faq";
import { fetchGuideMarkdown } from "./guideSource";

// Frequently asked questions, from docs/users/faq.md. The section is a shortcut
// into the guides, not the only way to an answer — if the file can't be read the
// section simply isn't shown, and search and the topics still work.
export function HelpFaq({ isAdmin }: { isAdmin: boolean }) {
  const { t } = useTranslation();
  const [entries, setEntries] = useState<FaqEntry[] | null>(null);

  useEffect(() => {
    let alive = true;
    fetchGuideMarkdown("faq")
      .then((markdown) => {
        if (alive) setEntries(markdown === null ? [] : parseFaq(markdown));
      })
      .catch(() => {
        if (alive) setEntries([]);
      });
    return () => {
      alive = false;
    };
  }, []);

  const shown = (entries ?? []).filter((entry) => isAdmin || !entry.adminOnly);
  if (!shown.length) return null;

  return (
    <section className="help-block" aria-labelledby="help-faq-heading">
      <h2 id="help-faq-heading">{t("help.faqHeading")}</h2>
      <div className="help-faq">
        {shown.map((entry, position) => (
          <FaqItem key={entry.question} entry={entry} id={`help-faq-${position}`} />
        ))}
      </div>
    </section>
  );
}

function FaqItem({ entry, id }: { entry: FaqEntry; id: string }) {
  const [open, setOpen] = useState(false);
  const [html, setHtml] = useState<string | null>(null);

  // Rendered on first open: marked is loaded on demand, and most answers are
  // never opened.
  useEffect(() => {
    if (!open || html !== null) return;
    let alive = true;
    renderGuideHtml(entry.answer).then((rendered) => {
      if (alive) setHtml(rendered);
    });
    return () => {
      alive = false;
    };
  }, [open, html, entry.answer]);

  return (
    <div className={cx("help-faq-item", open && "is-open")}>
      <h3 className="help-faq-question">
        <Button variant="bare" className="help-faq-toggle" aria-expanded={open} aria-controls={id} onClick={() => setOpen(!open)}>
          <span>{entry.question}</span>
          <ChevronDown size={18} aria-hidden="true" />
        </Button>
      </h3>
      {/* Our own file, shipped inside the image and sanitised by renderGuideHtml. */}
      <div
        id={id}
        className="help-faq-answer guide-body"
        hidden={!open}
        onClick={followGuideLink}
        dangerouslySetInnerHTML={{ __html: html ?? "" }}
      />
    </div>
  );
}
