import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { api } from "../../api";
import { followRoute } from "../../router";
import { Button } from "../../shared/Button";
import { MessageBox } from "../../shared/MessageBox";
import { versionLabel } from "../../shared/appVersion";

interface WhatsNew {
  version: string;
  stage: string | null;
  releases: { version: string; label: string }[];
  total: number;
}

const ABOUT_PATH = "/about";

// "Updated to X — what changed", once per upgrade (modules/home/whats-new.ts on the
// server decides who sees what). Headlines only; the About page has the notes.
// Either button records the version as seen. Silent on any failure: it is a
// courtesy, and Home must never show an error because of it.
export function WhatsNewNote() {
  const { t } = useTranslation();
  const [note, setNote] = useState<WhatsNew | null>(null);

  useEffect(() => {
    let alive = true;
    api<WhatsNew>("/api/home/whats-new")
      .then((result) => {
        if (alive && result.total > 0) setNote(result);
      })
      .catch(() => { /* a courtesy note; nothing to show on failure */ });
    return () => {
      alive = false;
    };
  }, []);

  if (!note) return null;

  const markSeen = () => {
    setNote(null);
    void api("/api/home/whats-new/seen", { method: "POST" }).catch(() => { /* shown again next visit */ });
  };
  const earlier = note.total - note.releases.length;

  return (
    <MessageBox
      tone="info"
      className="home-whats-new"
      title={t("whatsNew.title", { version: versionLabel(t, note.version, note.stage) })}
      action={
        <>
          <a
            className="text-button"
            href={ABOUT_PATH}
            onClick={(event) => {
              markSeen();
              followRoute(event, ABOUT_PATH);
            }}
          >
            {t("whatsNew.readMore")}
          </a>
          <Button variant="text" onClick={markSeen}>{t("whatsNew.dismiss")}</Button>
        </>
      }
    >
      {/* One release: the title already names it, so just its headline. Several:
          a short list of version and headline. */}
      {note.releases.length === 1 ? (
        <p className="home-whats-new-label">{note.releases[0].label}</p>
      ) : (
        <ul className="home-whats-new-list">
          {note.releases.map((release) => (
            <li key={release.version}>
              <span className="home-whats-new-version">{release.version}</span> — {release.label}
            </li>
          ))}
        </ul>
      )}
      {earlier > 0 && <p>{t("whatsNew.earlier", { count: earlier })}</p>}
    </MessageBox>
  );
}
