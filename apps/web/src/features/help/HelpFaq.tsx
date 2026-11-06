import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "../../shared/Button";
import { followGuideLink, renderGuideHtml } from "../../pages/GuidePage";
import { parseFaq, type FaqEntry } from "./faq";
import { fetchGuideMarkdown } from "./guideSource";

// Common questions, from docs/users/faq.md, as answer cards: the question, a few
// sentences, and the link into the guide section that says it properly. The
// section is a shortcut into the guides, not the only way to an answer — if the
// file can't be read the section simply isn't shown, and search and the shelves
// still work.
const FIRST_SHOWN = 6;

export function HelpFaq({ isAdmin }: { isAdmin: boolean }) {
  const { t } = useTranslation();
  const [entries, setEntries] = useState<FaqEntry[] | null>(null);
  const [answers, setAnswers] = useState<Map<string, string>>(new Map());
  const [all, setAll] = useState(false);

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

  const visible = (entries ?? []).filter((entry) => isAdmin || !entry.adminOnly);
  const shown = all ? visible : visible.slice(0, FIRST_SHOWN);

  // marked is loaded on demand; the answers render once the list is known.
  useEffect(() => {
    const missing = shown.filter((entry) => !answers.has(entry.question));
    if (!missing.length) return;
    let alive = true;
    Promise.all(missing.map(async (entry) => [entry.question, await renderGuideHtml(entry.answer)] as const)).then((rendered) => {
      if (alive) setAnswers((current) => new Map([...current, ...rendered]));
    });
    return () => {
      alive = false;
    };
  }, [shown, answers]);

  if (!visible.length) return null;

  return (
    <section className="help-block" aria-labelledby="help-faq-heading">
      <div className="help-block-head">
        <h2 id="help-faq-heading">{t("help.faqHeading")}</h2>
        {visible.length > FIRST_SHOWN && (
          <Button variant="text" onClick={() => setAll(!all)} aria-expanded={all}>
            {all ? t("help.fewerQuestions") : t("help.allQuestions", { count: visible.length })}
          </Button>
        )}
      </div>
      <div className="help-faq">
        {shown.map((entry) => (
          <div className="help-faq-card" key={entry.question}>
            <h3>{entry.question}</h3>
            {/* Our own file, shipped inside the image and sanitised by renderGuideHtml. */}
            <div
              className="help-faq-answer guide-body"
              onClick={followGuideLink}
              dangerouslySetInnerHTML={{ __html: answers.get(entry.question) ?? "" }}
            />
          </div>
        ))}
      </div>
    </section>
  );
}
