// The drop page — docs/photo-inbox-proposal.md, phase 3. Someone without an
// account lands here from a drop link and hands over photos into a Photo Inbox.
// Write-only on purpose: it says whose Inbox this is, what may still be sent,
// takes the files, and answers with a count. No thumbnails, no gallery, no way
// to see what else is in the Inbox — the smallest possible surface for the first
// anonymous write path in the app.
//
// Like SharePage it uses a bare fetch for the read (no session to send), and that
// first GET is what issues the CSRF cookie the upload's POST then carries.
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { CheckCircle2, Inbox } from "lucide-react";
import { FileUpload } from "../shared/FileUpload";
import { Button } from "../shared/Button";
import { formatBytes } from "../shared/utils";
// The guest pages' stylesheet, shared with SharePage: it loads with them, not on every route (docs/css-map.md).
import "../styles/share-page.css";

interface DropView {
  label: string | null;
  inboxName: string;
  sharedBy: string;
  expiresAt: string;
  accept: string[];
  maxFileBytes: number;
  remainingFiles: number | null;
  remainingBytes: number | null;
  oneTime: boolean;
  received: { files: number; bytes: number };
  open: boolean;
}

interface DropResult {
  received: number;
  remainingFiles: number | null;
  remainingBytes: number | null;
  closed: boolean;
}

const BATCH_CEILING = 200;

export function DropPage({ token }: { token: string }) {
  const { t } = useTranslation(["user", "common"]);
  const [view, setView] = useState<DropView | null>(null);
  const [loadError, setLoadError] = useState("");
  const [done, setDone] = useState<DropResult | null>(null);
  const [busy, setBusy] = useState(false);

  const load = () => {
    setLoadError("");
    fetch(`/api/drop/${token}`)
      .then(async (res) => {
        if (!res.ok) {
          const body = (await res.json().catch(() => ({}))) as { error?: string };
          throw new Error(body.error || t("user:dropPage.gone"));
        }
        return res.json() as Promise<DropView>;
      })
      .then((payload) => {
        setView(payload);
        document.title = payload.label
          ? t("user:dropPage.docTitleLabelled", { label: payload.label })
          : t("user:dropPage.docTitle");
      })
      .catch((err) => setLoadError(err instanceof Error ? err.message : t("user:dropPage.gone")));
  };

  useEffect(() => { load(); }, [token]); // eslint-disable-line react-hooks/exhaustive-deps

  if (loadError) {
    return (
      <div className="share-page">
        <div className="share-card share-card--message">
          <Inbox size={40} aria-hidden="true" />
          <h1>{t("user:dropPage.unavailableTitle")}</h1>
          <p className="muted">{loadError}</p>
        </div>
      </div>
    );
  }

  if (!view) {
    return (
      <div className="share-page">
        <div className="share-card share-card--message">
          <p className="muted">{t("user:common.loading")}</p>
        </div>
      </div>
    );
  }

  const allowance = (files: number | null, bytes: number | null): string | null => {
    const parts: string[] = [];
    if (files != null) parts.push(t("user:dropPage.filesLeft", { count: files }));
    if (bytes != null) parts.push(t("user:dropPage.bytesLeft", { size: formatBytes(bytes) }));
    return parts.length > 0 ? parts.join(" · ") : null;
  };

  return (
    <div className="share-page">
      <div className="share-card share-card--drop">
        <header className="drop-head">
          <Inbox size={28} aria-hidden="true" />
          <div>
            <h1>{view.label ?? t("user:dropPage.title")}</h1>
            <p className="muted">{t("user:dropPage.sharedBy", { name: view.sharedBy })}</p>
          </div>
        </header>

        {done ? (
          <section className="drop-thanks" aria-live="polite">
            <CheckCircle2 size={40} aria-hidden="true" />
            <h2>{t("user:dropPage.receivedTitle", { count: done.received })}</h2>
            <p className="muted">{t("user:dropPage.receivedBody")}</p>
            {done.closed ? (
              <p className="muted">{t("user:dropPage.closedBody")}</p>
            ) : (
              <>
                {allowance(done.remainingFiles, done.remainingBytes) && (
                  <p className="muted">{allowance(done.remainingFiles, done.remainingBytes)}</p>
                )}
                {(done.remainingFiles == null || done.remainingFiles > 0) && (done.remainingBytes == null || done.remainingBytes > 0) && (
                  <Button variant="secondary" onClick={() => { setDone(null); load(); }}>
                    {t("user:dropPage.sendMore")}
                  </Button>
                )}
              </>
            )}
          </section>
        ) : !view.open ? (
          <section className="drop-thanks">
            <p className="muted">{t("user:dropPage.fullBody")}</p>
          </section>
        ) : (
          <>
            <p className="drop-intro">{t("user:dropPage.intro", { inbox: view.inboxName })}</p>
            {allowance(view.remainingFiles, view.remainingBytes) && (
              <p className="muted drop-allowance">{allowance(view.remainingFiles, view.remainingBytes)}</p>
            )}
            <FileUpload
              endpoint={`/api/drop/${token}/upload`}
              accept={view.accept}
              maxBytes={view.maxFileBytes}
              multiple
              maxFiles={Math.min(BATCH_CEILING, view.remainingFiles ?? BATCH_CEILING)}
              hint={t("user:dropPage.hint", {
                types: view.accept.map((ext) => `.${ext}`).join(", "),
                size: formatBytes(view.maxFileBytes)
              })}
              onUploaded={(response) => setDone(response as DropResult)}
              onBusyChange={setBusy}
            />
            {busy && <p className="muted">{t("user:dropPage.sending")}</p>}
          </>
        )}

        <footer className="share-footer muted">
          {t("user:dropPage.footer")}
        </footer>
      </div>
    </div>
  );
}
