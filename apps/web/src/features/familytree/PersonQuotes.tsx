import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { Quote as QuoteIcon } from "lucide-react";
import { api } from "../../api";
import { MessageBox } from "../../shared/MessageBox";
import { navigate } from "../../router";
import { Button } from "../../shared/Button";
import type { Quote } from "../audiobooks/types";

// The things this person said, on their own profile.
//
// A quote is its own entity (modules/library/quotes.ts), not a property of a
// person — the same row can be a family saying here, a card on the home page and
// a line on the Quotes page. So this READS them and sends editing back to the
// Quotes page, where the whole editor already lives.
//
// The server returns this person's quotes that the viewer may see: everything
// shared with the family, plus the viewer's own private ones. Reading the tree
// is open to every signed-in user, so a quote's own visibility is the only gate.
export function PersonQuotes({ personId, personName }: { personId: string; personName: string }) {
  const { t } = useTranslation(["common", "user", "family"]);
  const [quotes, setQuotes] = useState<Quote[] | null>(null);
  const [error, setError] = useState("");

  useEffect(() => {
    setQuotes(null);
    setError("");
    api<{ quotes: Quote[] }>(`/api/library/quotes?personId=${encodeURIComponent(personId)}`)
      .then((payload) => setQuotes(payload.quotes))
      .catch((err) => setError(err instanceof Error ? err.message : t("user:quotes.loadFailed")));
  }, [personId]);

  if (error) {
    return <MessageBox tone="error" title={t("user:quotes.errorTitle")}>{error}</MessageBox>;
  }
  if (quotes === null) {
    return <p className="ft-relation-empty">{t("user:quotes.loading")}</p>;
  }
  if (quotes.length === 0) {
    return (
      <div className="ft-person-quotes-empty">
        <p className="ft-relation-empty">{t("family:person.quotes.empty", { name: personName })}</p>
        <Button variant="secondary" compact onClick={() => navigate("/quotes")}>
          {t("family:person.quotes.goToQuotes")}
        </Button>
      </div>
    );
  }

  return (
    <div className="ft-person-quotes">
      {quotes.map((quote) => (
        <article className="ft-person-quote" key={quote.id}>
          <span className="ft-person-quote-mark" aria-hidden="true"><QuoteIcon size={15} /></span>
          <div className="ft-person-quote-body">
            <blockquote>{quote.text}</blockquote>
            {/* When and where it was said — the two things that turn a line into
                a memory. Both optional, so the row collapses when neither is set. */}
            {(quote.quoteDate || quote.context) && (
              <p className="ft-person-quote-meta">
                {[quote.quoteDate, quote.context].filter(Boolean).join(" · ")}
              </p>
            )}
          </div>
        </article>
      ))}
    </div>
  );
}
