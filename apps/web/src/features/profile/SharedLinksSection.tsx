import { useState, useEffect } from "react";
import { BookOpen, Headphones, Image, Images, Link2 } from "lucide-react";
import { api } from "../../api";
import { Button } from "../../shared/Button";
import { ConfirmDialog } from "../../shared/ConfirmDialog";
import { MessageBox } from "../../shared/MessageBox";

interface SharedLink {
  id: string;
  kind: "item" | "set" | "album";
  module: string;
  resourceId: string | null;
  title: string;
  label: string | null;
  itemCount: number;
  createdAt: string;
  expiresAt: string;
  status: "active" | "expired";
}

const KIND_ICON = {
  audiobook: Headphones,
  ebook: BookOpen,
  gallery: Image,
  gallery_set: Images,
  gallery_album: Images
} as const;

function iconFor(module: string) {
  return KIND_ICON[module as keyof typeof KIND_ICON] ?? Link2;
}

const DAY = 24 * 60 * 60 * 1000;

// "Expires in 3 days" is the thing you actually want to know when auditing; the
// exact date matters only once it is far enough out to stop being urgent.
function expiryText(link: SharedLink): string {
  const expires = new Date(link.expiresAt);
  if (link.status === "expired") {
    return `Expired ${expires.toLocaleDateString()}`;
  }
  const remaining = expires.getTime() - Date.now();
  if (remaining < DAY) return "Expires within a day";
  const days = Math.round(remaining / DAY);
  if (days <= 14) return `Expires in ${days} days`;
  return `Expires ${expires.toLocaleDateString()}`;
}

function describe(link: SharedLink): string {
  if (link.kind === "set") return `${link.itemCount} photo${link.itemCount === 1 ? "" : "s"}`;
  if (link.kind === "album") return `Album · ${link.itemCount} item${link.itemCount === 1 ? "" : "s"}`;
  return link.module === "ebook" ? "Ebook" : link.module === "gallery" ? "Photo" : "Audiobook";
}

export function SharedLinksSection() {
  const [links, setLinks] = useState<SharedLink[] | null>(null);
  const [error, setError] = useState("");
  const [revoking, setRevoking] = useState<SharedLink | null>(null);
  const [busy, setBusy] = useState(false);
  const [revokeError, setRevokeError] = useState("");

  const load = () => {
    api<{ shares: SharedLink[] }>("/api/shares/mine")
      .then((payload) => setLinks(payload.shares))
      .catch((err) => setError(err instanceof Error ? err.message : "Unable to load shared links"));
  };

  useEffect(load, []);

  const revoke = async () => {
    if (!revoking) return;
    setBusy(true);
    setRevokeError("");
    try {
      await api(`/api/shares/${revoking.id}`, { method: "DELETE" });
      setRevoking(null);
      load();
    } catch (err) {
      setRevokeError(err instanceof Error ? err.message : "Unable to revoke link");
    } finally {
      setBusy(false);
    }
  };

  const active = links?.filter((link) => link.status === "active") ?? [];
  const expired = links?.filter((link) => link.status === "expired") ?? [];

  const row = (link: SharedLink) => {
    const Icon = iconFor(link.module);
    return (
      <li className={`shared-link-row${link.status === "expired" ? " is-expired" : ""}`} key={link.id}>
        <span className="shared-link-icon" aria-hidden="true"><Icon size={18} /></span>
        <div className="shared-link-main">
          <span className="shared-link-title">{link.title}</span>
          <span className="shared-link-meta">
            {describe(link)}
            {link.label && ` · ${link.label}`}
            {` · shared ${new Date(link.createdAt).toLocaleDateString()}`}
          </span>
        </div>
        <span className="shared-link-expiry">{expiryText(link)}</span>
        <Button variant="text" onClick={() => { setRevokeError(""); setRevoking(link); }}>
          Revoke
        </Button>
      </li>
    );
  };

  return (
    <section className="shared-links-section" aria-labelledby="shared-links-heading">
      <h2 id="shared-links-heading">Shared links</h2>
      <p className="shared-links-intro">
        Every guest link you have created that has not been revoked. Anyone holding one of
        these can open what it points at without signing in, until it expires. The link
        addresses themselves are not stored and cannot be shown again — if you have lost
        one, revoke it and create a new one.
      </p>

      {error && <MessageBox tone="error" title="Unable to load shared links">{error}</MessageBox>}

      {links && links.length === 0 && (
        <MessageBox tone="info" title="Nothing is shared">
          You have not created any guest links. You can make one from the Share button on any
          book, photo, or album.
        </MessageBox>
      )}

      {active.length > 0 && (
        <>
          <h3 className="shared-links-group">Active ({active.length})</h3>
          <ul className="shared-link-list">{active.map(row)}</ul>
        </>
      )}

      {expired.length > 0 && (
        <>
          <h3 className="shared-links-group">Expired ({expired.length})</h3>
          <p className="shared-links-note">
            These no longer grant access. Revoking them just clears them from this list.
          </p>
          <ul className="shared-link-list">{expired.map(row)}</ul>
        </>
      )}

      {revoking && (
        <ConfirmDialog
          title={`Revoke the link to "${revoking.title}"?`}
          confirmLabel="Revoke link"
          busyLabel="Revoking…"
          danger
          busy={busy}
          error={revokeError}
          onConfirm={revoke}
          onCancel={() => setRevoking(null)}
        >
          {revoking.status === "expired"
            ? "This link has already expired, so nobody can use it. Revoking removes it from the list."
            : "Anyone still holding this link will lose access immediately. Nothing is deleted, and people you shared with by account keep their access."}
        </ConfirmDialog>
      )}
    </section>
  );
}
