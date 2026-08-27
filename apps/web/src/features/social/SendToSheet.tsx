import { useEffect, useState } from "react";
import { Trans, useTranslation } from "react-i18next";
import { Link2, Send, Tablet, UserRound } from "lucide-react";
import { api } from "../../api";
import { Modal } from "../../shared/Modal";
import { Button } from "../../shared/Button";
import { MessageBox } from "../../shared/MessageBox";

// One button for every way of getting a thing to somewhere. Before this there
// were three, in three different menus, all meaning "send": mail it to my
// Kindle, make a guest link, tell a family member. The destination picks the
// mechanism — a person gets a pointer, a Kindle gets a file, a link gets a
// token — and the user never has to know there is one.
//
// Two steps, never more: pick a destination, then (for a person) write a line.

export interface SendToSubject {
  entityType: string;
  entityId: string;
}

interface Person {
  id: string;
  displayName: string;
  alreadySent: boolean;
  /** Whether they can already open this under their own access. */
  canOpen: boolean;
}

interface Destinations {
  subject: { title: string; subtitle: string | null; coverUrl: string | null; href: string };
  people: Person[];
  /** Whether the caller is allowed to widen access to the people who cannot. */
  canGrant: boolean;
  ereader: { applicable: boolean; configured: boolean };
  guestLink: boolean;
}

export function SendToSheet({
  subject,
  onClose,
  onGuestLink,
  onSendToEreader
}: {
  subject: SendToSubject;
  onClose: () => void;
  /** Opens the host page's existing guest-link flow. Omit to hide the row. */
  onGuestLink?: () => void;
  /** Mails the file to the caller's own e-reader. Omit to hide the row. */
  onSendToEreader?: () => Promise<void>;
}) {
  const { t } = useTranslation(["common", "user"]);
  const [destinations, setDestinations] = useState<Destinations | null>(null);
  const [loadError, setLoadError] = useState("");
  const [recipient, setRecipient] = useState<Person | null>(null);
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [sentTo, setSentTo] = useState("");

  useEffect(() => {
    const params = new URLSearchParams({ entityType: subject.entityType, entityId: subject.entityId });
    api<Destinations>(`/api/social/destinations?${params.toString()}`)
      .then(setDestinations)
      .catch((err) => setLoadError(err instanceof Error ? err.message : t("user:sendTo.loadFailed")));
  }, [subject.entityType, subject.entityId]);

  const send = async () => {
    if (!recipient) return;
    setBusy(true);
    setError("");
    try {
      await api("/api/social/recommendations", {
        method: "POST",
        body: JSON.stringify({
          entityType: subject.entityType,
          entityId: subject.entityId,
          toUserIds: [recipient.id],
          message: message.trim() || null,
          // Only ever true after the compose step has said so in words.
          grantAccess: !recipient.canOpen
        })
      });
      setSentTo(recipient.displayName);
    } catch (err) {
      setError(err instanceof Error ? err.message : t("user:sendTo.sendFailed"));
    } finally {
      setBusy(false);
    }
  };

  const sendToEreader = async () => {
    if (!onSendToEreader) return;
    setBusy(true);
    setError("");
    try {
      await onSendToEreader();
      setSentTo(t("user:sendTo.yourEreader"));
    } catch (err) {
      setError(err instanceof Error ? err.message : t("user:sendTo.ereaderFailed"));
    } finally {
      setBusy(false);
    }
  };

  // Sent. One line, one button — there is nothing else to decide here.
  if (sentTo) {
    return (
      <Modal title={t("user:sendTo.sentTitle")} onClose={onClose}>
        <p className="send-to-done">
          <Trans i18nKey="sendTo.onItsWay" ns="user" values={{ name: sentTo }} components={{ bold: <strong /> }} />
        </p>
        <div className="modal-actions">
          <Button variant="primary" onClick={onClose}>{t("common:common.done")}</Button>
        </div>
      </Modal>
    );
  }

  // Step two: writing the line. Optional — Send works with an empty box.
  if (recipient) {
    return (
      <Modal
        title={t("user:sendTo.sendToName", { name: recipient.displayName })}
        busy={busy}
        onClose={onClose}
        onSubmit={(event) => { event.preventDefault(); void send(); }}
      >
        {destinations && <SubjectCard subject={destinations.subject} />}
        <label className="send-to-field">
          <span>{t("user:sendTo.sayField")}</span>
          <input
            type="text"
            value={message}
            maxLength={280}
            autoFocus
            placeholder={t("user:sendTo.sayPlaceholder")}
            onChange={(event) => setMessage(event.target.value)}
          />
        </label>
        <p className="send-to-note">
          {recipient.canOpen
            ? t("user:sendTo.linkNote", { name: recipient.displayName })
            : t("user:sendTo.grantNote", { name: recipient.displayName })}
        </p>
        {error && <MessageBox tone="error" title={t("user:sendTo.sendFailed")}>{error}</MessageBox>}
        <div className="modal-actions">
          <Button variant="secondary" onClick={() => setRecipient(null)} disabled={busy}>{t("user:sendTo.back")}</Button>
          <Button variant="primary" type="submit" disabled={busy}>
            {busy ? t("user:actions.sending") : recipient.canOpen ? t("user:actions.send") : t("user:sendTo.giveAccessSend")}
          </Button>
        </div>
      </Modal>
    );
  }

  // Step one: the destinations themselves.
  const needsAccess = destinations?.people.filter((person) => !person.canOpen) ?? [];

  return (
    <Modal title={t("user:sendTo.title")} busy={busy} onClose={onClose}>
      {loadError && <MessageBox tone="error" title={t("user:common.unableToLoad")}>{loadError}</MessageBox>}
      {destinations && (
        <>
          <SubjectCard subject={destinations.subject} />

          <ul className="send-to-list">
            {destinations.people.filter((person) => person.canOpen).map((person) => (
              <PersonRow key={person.id} person={person} onPick={setRecipient} />
            ))}
            {destinations.people.length === 0 && (
              <li className="send-to-empty">{t("user:sendTo.nobody")}</li>
            )}
          </ul>

          {/* The half that used to send you to a separate Share dialog. Listed
              here, greyed with a reason, so the answer to "why isn't Mom in the
              list?" is on screen instead of in another menu. */}
          {needsAccess.length > 0 && (
            <>
              <p className="send-to-group-label">
                {destinations.canGrant ? t("user:sendTo.noAccessYet") : t("user:sendTo.cantOpen")}
              </p>
              <ul className="send-to-list">
                {needsAccess.map((person) => (
                  <PersonRow
                    key={person.id}
                    person={person}
                    onPick={destinations.canGrant ? setRecipient : undefined}
                  />
                ))}
              </ul>
            </>
          )}

          {(destinations.ereader.applicable || (destinations.guestLink && onGuestLink)) && (
            <ul className="send-to-list send-to-list-devices">
              {destinations.ereader.applicable && onSendToEreader && (
                <li>
                  {destinations.ereader.configured ? (
                    <button type="button" className="send-to-option" disabled={busy} onClick={() => void sendToEreader()}>
                      <Tablet size={18} aria-hidden />
                      <span className="send-to-option-label">{busy ? t("user:actions.sending") : t("user:sendTo.myEreader")}</span>
                    </button>
                  ) : (
                    <a className="send-to-option" href="/profile">
                      <Tablet size={18} aria-hidden />
                      <span className="send-to-option-label">{t("user:sendTo.setupEreader")}</span>
                      <span className="send-to-hint">{t("user:sendTo.ereaderHint")}</span>
                    </a>
                  )}
                </li>
              )}
              {destinations.guestLink && onGuestLink && (
                <li>
                  <button type="button" className="send-to-option" onClick={onGuestLink}>
                    <Link2 size={18} aria-hidden />
                    <span className="send-to-option-label">{t("user:sendTo.anyoneWithLink")}</span>
                  </button>
                </li>
              )}
            </ul>
          )}
        </>
      )}
      {error && <MessageBox tone="error" title={t("user:sendTo.sendFailed")}>{error}</MessageBox>}
      <div className="modal-actions">
        <Button variant="secondary" onClick={onClose} disabled={busy}>{t("common:common.cancel")}</Button>
      </div>
    </Modal>
  );
}

function PersonRow({ person, onPick }: { person: Person; onPick?: (person: Person) => void }) {
  const { t } = useTranslation(["common", "user"]);
  return (
    <li>
      <button
        type="button"
        className="send-to-option"
        disabled={!onPick}
        onClick={() => onPick?.(person)}
      >
        <UserRound size={18} aria-hidden />
        <span className="send-to-option-label">{person.displayName}</span>
        {!person.canOpen && (
          <span className="send-to-hint">{onPick ? t("user:sendTo.willGetAccess") : t("user:sendTo.noAccess")}</span>
        )}
        {person.canOpen && person.alreadySent && <span className="send-to-hint">{t("user:sendTo.alreadySent")}</span>}
      </button>
    </li>
  );
}

function SubjectCard({ subject }: { subject: Destinations["subject"] }) {
  return (
    <div className="send-to-subject">
      {subject.coverUrl
        ? <img src={subject.coverUrl} alt="" className="send-to-subject-cover" />
        : <span className="send-to-subject-cover send-to-subject-cover-empty" aria-hidden><Send size={16} /></span>}
      <span className="send-to-subject-text">
        <strong>{subject.title}</strong>
        {subject.subtitle && <span>{subject.subtitle}</span>}
      </span>
    </div>
  );
}
