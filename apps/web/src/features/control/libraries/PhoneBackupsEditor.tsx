import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { api } from "../../../api";
import { MessageBox } from "../../../shared/MessageBox";
import { controlHref, followRoute } from "../../../router";

/** One phone on a library's Phone backups tab (GET /api/photo-sync/libraries/:id/phones). */
export interface LibraryPhone {
  id: string;
  label: string | null;
  member: { id: string; name: string };
  linked: boolean;
  /** Its owner can open the library: only then does the link count. */
  canOpen: boolean;
}

export interface LibraryPhonesView {
  syncOn: boolean;
  phones: LibraryPhone[];
}

/** The edit dialog's Phone backups tab (docs/photo-sync-plan.md, phase 6): which members'
 *  phones skip photos already in this library. Loads the phones itself and hands the
 *  ticked ones up (null until loaded); the dialog saves them with the rest. */
export function PhoneBackupsEditor({ libraryId, value, onChange }: {
  libraryId: string;
  value: string[] | null;
  onChange: (deviceIds: string[]) => void;
}) {
  const { t } = useTranslation(["common", "control"]);
  const [view, setView] = useState<LibraryPhonesView | null>(null);
  const [error, setError] = useState("");

  useEffect(() => {
    let live = true;
    setError("");
    api<LibraryPhonesView>(`/api/photo-sync/libraries/${encodeURIComponent(libraryId)}/phones`)
      .then((loaded) => {
        if (!live) return;
        setView(loaded);
        if (value === null) onChange(loaded.phones.filter((phone) => phone.linked).map((phone) => phone.id));
      })
      .catch((err) => { if (live) setError(err instanceof Error ? err.message : t("control:libraries.phoneBackups.unableToLoad")); });
    return () => { live = false; };
    // Loaded once per library; `value` is seeded from it, not a reason to reload.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [libraryId]);

  if (error) return <MessageBox tone="error" title={t("control:libraries.phoneBackups.unableToLoad")}>{error}</MessageBox>;
  if (!view || value === null) return <p className="muted">{t("control:libraries.phoneBackups.loading")}</p>;

  const ticked = new Set(value);
  const toggle = (id: string, on: boolean) => onChange(on ? [...value, id] : value.filter((other) => other !== id));

  return (
    <section className="phone-backups-editor" aria-label={t("control:libraries.tabPhoneBackups")}>
      <p className="muted">{t("control:libraries.phoneBackups.intro")}</p>
      {!view.syncOn && (
        <MessageBox tone="info" title={t("control:libraries.phoneBackups.syncOffTitle")}>
          {t("control:libraries.phoneBackups.syncOffBody")}{" "}
          <a href={controlHref("phoneSync")} onClick={(event) => followRoute(event, controlHref("phoneSync"))}>{t("control:libraries.phoneBackups.openPhoneSync")}</a>
        </MessageBox>
      )}
      {view.phones.length === 0 ? (
        <p className="muted">{t("control:libraries.phoneBackups.none")}</p>
      ) : (
        <div className="phone-backups-list">
          {view.phones.map((phone) => (
            <label key={phone.id} className="field-checkbox">
              <input
                type="checkbox"
                checked={ticked.has(phone.id)}
                disabled={!phone.canOpen && !ticked.has(phone.id)}
                onChange={(event) => toggle(phone.id, event.target.checked)}
              />
              <span>
                {t("control:libraries.phoneBackups.phoneLine", { phone: phone.label ?? t("control:libraries.phoneBackups.unnamed"), member: phone.member.name })}
                {!phone.canOpen && <small>{t("control:libraries.phoneBackups.cannotOpen", { member: phone.member.name })}</small>}
              </span>
            </label>
          ))}
        </div>
      )}
      <MessageBox tone="info" title={t("control:libraries.phoneBackups.howTitle")}>
        {t("control:libraries.phoneBackups.howBody")}
      </MessageBox>
    </section>
  );
}
