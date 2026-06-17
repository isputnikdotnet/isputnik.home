import { useEffect, useState, type FormEvent } from "react";
import { QRCodeSVG } from "qrcode.react";
import { Check, Copy, Plus, Trash2 } from "lucide-react";
import { api } from "../../api";
import { Button } from "../../shared/Button";
import { Field } from "../../shared/Field";
import { Modal } from "../../shared/Modal";
import { MessageBox } from "../../shared/MessageBox";
import { ConfirmDialog } from "../../shared/ConfirmDialog";

interface OpdsToken {
  id: string;
  label: string | null;
  scope: string;
  createdAt: string;
  lastSeen: string | null;
  lastIp: string | null;
  expiresAt: string | null;
}

// The one-time secret payload returned when a token is minted.
interface CreatedToken {
  id: string;
  token: string;
  catalogUrl: string;
  basicUrl: string;
  username: string;
}

function CopyRow({ label, value, copied, onCopy }: { label: string; value: string; copied: boolean; onCopy: () => void }) {
  return (
    <div className="opds-copy-row">
      <span className="opds-copy-label">{label}</span>
      <code className="opds-copy-value">{value}</code>
      <Button variant="icon" title={`Copy ${label.toLowerCase()}`} aria-label={`Copy ${label.toLowerCase()}`} onClick={onCopy}>
        {copied ? <Check size={16} /> : <Copy size={16} />}
      </Button>
    </div>
  );
}

export function OpdsAccessSection() {
  const [tokens, setTokens] = useState<OpdsToken[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  const [createOpen, setCreateOpen] = useState(false);
  const [label, setLabel] = useState("");
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState("");
  const [created, setCreated] = useState<CreatedToken | null>(null);

  const [pendingRemove, setPendingRemove] = useState<OpdsToken | null>(null);
  const [removing, setRemoving] = useState(false);
  const [copied, setCopied] = useState<string | null>(null);

  const load = async () => {
    try {
      const payload = await api<{ tokens: OpdsToken[] }>("/api/account/tokens");
      setTokens(payload.tokens);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unable to load reader tokens");
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void load();
  }, []);

  const copy = async (key: string, value: string) => {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(key);
      setTimeout(() => setCopied((current) => (current === key ? null : current)), 1500);
    } catch {
      /* clipboard unavailable — the value is still visible to copy by hand */
    }
  };

  const openCreate = () => {
    setLabel("");
    setCreateError("");
    setCreated(null);
    setCreateOpen(true);
  };

  const closeCreate = () => {
    setCreateOpen(false);
    setCreated(null);
    setCreateError("");
    setLabel("");
  };

  const create = async (event: FormEvent) => {
    event.preventDefault();
    setCreating(true);
    setCreateError("");
    try {
      const payload = await api<CreatedToken>("/api/account/tokens", {
        method: "POST",
        body: JSON.stringify({ label: label.trim() || undefined })
      });
      setCreated(payload);
      await load();
    } catch (err) {
      setCreateError(err instanceof Error ? err.message : "Unable to create token");
    } finally {
      setCreating(false);
    }
  };

  const remove = async () => {
    if (!pendingRemove) return;
    setRemoving(true);
    setError("");
    try {
      await api(`/api/account/tokens/${pendingRemove.id}`, { method: "DELETE" });
      setPendingRemove(null);
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unable to remove token");
    } finally {
      setRemoving(false);
    }
  };

  return (
    <section className="opds-access" aria-labelledby="opds-access-heading">
      <h2 id="opds-access-heading">Reader access (OPDS)</h2>
      <p className="opds-intro">
        Read your ebooks in apps like KOReader, Moon+ Reader or Thorium. Create a token for a device, then
        paste its catalog link into the reader. Each token is read-only and can be removed at any time.
      </p>

      {error && <MessageBox tone="error" title="Reader access">{error}</MessageBox>}

      <div className="opds-actions">
        <Button variant="primary" onClick={openCreate}>
          <Plus size={16} /> Create token
        </Button>
      </div>

      <div className="opds-token-list">
        {loading ? (
          <p className="opds-intro">Loading…</p>
        ) : tokens.length === 0 ? (
          <p className="opds-intro">No reader tokens yet.</p>
        ) : (
          tokens.map((token) => (
            <div className="opds-token-row" key={token.id}>
              <div className="opds-token-meta">
                <strong>{token.label || "Reader token"}</strong>
                <span className="opds-intro">
                  Added {new Date(token.createdAt).toLocaleDateString()}
                  {token.lastSeen ? ` · last used ${new Date(token.lastSeen).toLocaleDateString()}` : " · never used"}
                </span>
              </div>
              <Button
                variant="icon"
                danger
                title="Remove token"
                aria-label={`Remove ${token.label || "reader token"}`}
                onClick={() => setPendingRemove(token)}
              >
                <Trash2 size={18} />
              </Button>
            </div>
          ))
        )}
      </div>

      {createOpen && (
        <Modal
          variant="card"
          className="opds-token-modal"
          title={created ? "Reader token created" : "Create reader token"}
          busy={creating}
          onClose={closeCreate}
          onSubmit={created ? undefined : create}
        >
          {created ? (
            <div className="opds-created">
              <MessageBox tone="success" title="Copy it now">
                This is the only time the token is shown. Paste the catalog link into your reader to finish.
              </MessageBox>

              <CopyRow label="Catalog link" value={created.catalogUrl} copied={copied === "catalog"} onCopy={() => copy("catalog", created.catalogUrl)} />

              <div className="opds-qr">
                <QRCodeSVG value={created.catalogUrl} size={140} bgColor="#ffffff" fgColor="#031116" />
                <span className="opds-intro">Scan to add the catalog on a phone or tablet.</span>
              </div>

              <details className="opds-basic">
                <summary>Prefer a username &amp; password? (HTTP Basic)</summary>
                <CopyRow label="Server URL" value={created.basicUrl} copied={copied === "basicurl"} onCopy={() => copy("basicurl", created.basicUrl)} />
                <CopyRow label="Username" value={created.username} copied={copied === "user"} onCopy={() => copy("user", created.username)} />
                <CopyRow label="Password (token)" value={created.token} copied={copied === "pwd"} onCopy={() => copy("pwd", created.token)} />
              </details>

              <div className="modal-actions">
                <Button variant="primary" onClick={closeCreate}>Done</Button>
              </div>
            </div>
          ) : (
            <>
              <p className="opds-intro">Name the device this token is for, so you can recognise it later.</p>
              <Field label="Device name" value={label} onChange={setLabel} placeholder="e.g. Kobo Clara" required={false} />
              {createError && <MessageBox tone="error" title="Unable to create token">{createError}</MessageBox>}
              <div className="modal-actions">
                <Button variant="secondary" onClick={closeCreate} disabled={creating}>Cancel</Button>
                <Button variant="primary" type="submit" disabled={creating}>
                  {creating ? "Creating…" : "Create token"}
                </Button>
              </div>
            </>
          )}
        </Modal>
      )}

      {pendingRemove && (
        <ConfirmDialog
          title={`Remove "${pendingRemove.label || "Reader token"}"?`}
          confirmLabel="Remove token"
          busyLabel="Removing…"
          danger
          busy={removing}
          onConfirm={remove}
          onCancel={() => setPendingRemove(null)}
        >
          That device will lose access to your ebooks at its next catalog refresh. Your other devices are not affected.
        </ConfirmDialog>
      )}
    </section>
  );
}
