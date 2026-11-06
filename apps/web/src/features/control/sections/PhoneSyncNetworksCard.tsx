import { useCallback, useEffect, useState, type FormEvent } from "react";
import { useTranslation } from "react-i18next";
import { Copy, Plus, Save, Smartphone, Trash2 } from "lucide-react";
import { api } from "../../../api";
import { Button } from "../../../shared/Button";
import { Field } from "../../../shared/Field";
import { MessageBox } from "../../../shared/MessageBox";
import { Modal } from "../../../shared/Modal";
import { formatManagedDate } from "../../../shared/utils";

interface SyncNetwork {
  id: string;
  cidr: string;
  label: string | null;
  createdAt: string;
}

interface PhoneSyncView {
  networks: SyncNetwork[];
  /** "Address phones use", e.g. http://192.168.2.10:4000; null until an admin types it. */
  address: string | null;
  addressOutsideNetworks: boolean;
}

// Security › Phone sync, first card (until phase 5 it sat under Trusted networks):
// phone-sync networks — where a phone may back up from (docs/photo-sync-plan.md, decision 2). Its own list, deliberately apart from
// the trusted networks above it, which also skip MFA, lockout and rate limits. Empty =
// phone sync off. Also "Address phones use", which the admin types once: home never
// guesses it (owner, 2026-11-05; plan open question 9).
//
// `refreshKey` reloads it when the page changed the list elsewhere (the phone list's
// "Add 192.168.12.0/24"); `onChange` tells the page this card changed it.
export function PhoneSyncNetworksCard({ refreshKey = 0, onChange }: { refreshKey?: number; onChange?: () => void } = {}) {
  const { t } = useTranslation(["common", "controlAdmin"]);
  const [view, setView] = useState<PhoneSyncView | null>(null);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");

  const [addOpen, setAddOpen] = useState(false);
  const [cidr, setCidr] = useState("");
  const [label, setLabel] = useState("");
  const [adding, setAdding] = useState(false);
  const [addError, setAddError] = useState("");
  const [copying, setCopying] = useState(false);

  const [address, setAddress] = useState("");
  const [savingAddress, setSavingAddress] = useState(false);

  const apply = useCallback((next: PhoneSyncView) => {
    setView(next);
    setAddress(next.address ?? "");
  }, []);
  /** A change made here: shown, and told to the page. */
  const applyChange = (next: PhoneSyncView) => {
    apply(next);
    onChange?.();
  };

  const load = useCallback(async () => {
    try {
      apply(await api<PhoneSyncView>("/api/photo-sync/networks"));
    } catch (err) {
      setError(err instanceof Error ? err.message : t("controlAdmin:phoneSync.loadFailed"));
    }
  }, [apply, t]);

  useEffect(() => { void load(); }, [load, refreshKey]);

  const closeAdd = () => {
    setAddOpen(false);
    setCidr("");
    setLabel("");
    setAddError("");
  };

  const add = async (event: FormEvent) => {
    event.preventDefault();
    setAdding(true);
    setAddError("");
    try {
      applyChange(await api<PhoneSyncView>("/api/photo-sync/networks", {
        method: "POST",
        body: JSON.stringify({ cidr: cidr.trim(), label: label.trim() || undefined })
      }));
      closeAdd();
    } catch (err) {
      setAddError(err instanceof Error ? err.message : t("controlAdmin:phoneSync.addFailed"));
    } finally {
      setAdding(false);
    }
  };

  const copyTrusted = async () => {
    setCopying(true);
    setError("");
    setNotice("");
    try {
      const next = await api<PhoneSyncView & { added: number }>("/api/photo-sync/networks/copy-trusted", { method: "POST" });
      applyChange(next);
      setNotice(next.added > 0 ? t("controlAdmin:phoneSync.copied", { count: next.added }) : t("controlAdmin:phoneSync.copiedNone"));
    } catch (err) {
      setError(err instanceof Error ? err.message : t("controlAdmin:phoneSync.updateFailed"));
    } finally {
      setCopying(false);
    }
  };

  const remove = async (id: string) => {
    setError("");
    setNotice("");
    try {
      applyChange(await api<PhoneSyncView>(`/api/photo-sync/networks/${id}`, { method: "DELETE" }));
    } catch (err) {
      setError(err instanceof Error ? err.message : t("controlAdmin:phoneSync.updateFailed"));
    }
  };

  const saveAddress = async (clear: boolean) => {
    setSavingAddress(true);
    setError("");
    setNotice("");
    try {
      apply(await api<PhoneSyncView>("/api/photo-sync/address", {
        method: "PUT",
        body: JSON.stringify({ address: clear ? null : address.trim() })
      }));
      setNotice(clear ? t("controlAdmin:phoneSync.addressCleared") : t("controlAdmin:phoneSync.addressSaved"));
    } catch (err) {
      setError(err instanceof Error ? err.message : t("controlAdmin:phoneSync.addressFailed"));
    } finally {
      setSavingAddress(false);
    }
  };

  // The server validates it properly; this only keeps Save off for an obvious non-URL.
  const addressValid = address.trim().toLowerCase().startsWith("http://") || address.trim().toLowerCase().startsWith("https://");

  return (
    <section id="phone-sync-networks" className="security-block security-network-view compact-tables" aria-labelledby="phone-sync-heading">
      <div className="security-network-head">
        <h2 id="phone-sync-heading">{t("controlAdmin:phoneSync.heading")}</h2>
        <p className="section-description">{t("controlAdmin:phoneSync.desc")}</p>
      </div>

      <MessageBox tone="info" title={t("controlAdmin:phoneSync.apartTitle")} className="security-network-callout">
        {t("controlAdmin:phoneSync.apartBody")}
      </MessageBox>

      <div className="security-list-actions">
        <Button variant="primary" onClick={() => { setAddError(""); setAddOpen(true); }}>
          <Plus size={16} />
          {t("controlAdmin:phoneSync.add")}
        </Button>
        <Button variant="secondary" onClick={() => void copyTrusted()} disabled={copying}>
          <Copy size={16} />
          {copying ? t("controlAdmin:phoneSync.copying") : t("controlAdmin:phoneSync.copyTrusted")}
        </Button>
      </div>

      {error && <MessageBox tone="error" title={t("controlAdmin:phoneSync.updateFailed")}>{error}</MessageBox>}
      {notice && <MessageBox tone="success" title={t("controlAdmin:phoneSync.doneTitle")}>{notice}</MessageBox>}

      {view && view.networks.length === 0 && (
        <MessageBox tone="warning" title={t("controlAdmin:phoneSync.offTitle")}>{t("controlAdmin:phoneSync.offBody")}</MessageBox>
      )}

      {view && view.networks.length > 0 && (
        <div className="datagrid-wrap security-network-table">
          <table className="datagrid trusted-table">
            <thead>
              <tr>
                <th>{t("controlAdmin:security.thRange")}</th>
                <th>{t("controlAdmin:security.thLabel")}</th>
                <th>{t("controlAdmin:security.thAdded")}</th>
                <th className="col-actions">{t("controlAdmin:security.thActions")}</th>
              </tr>
            </thead>
            <tbody>
              {view.networks.map((network) => (
                <tr key={network.id}>
                  <td><code>{network.cidr}</code></td>
                  <td className="datagrid-muted">{network.label || "—"}</td>
                  <td className="datagrid-muted">{formatManagedDate(network.createdAt)}</td>
                  <td className="col-actions">
                    <Button
                      variant="icon"
                      danger
                      title={t("controlAdmin:phoneSync.remove")}
                      aria-label={t("controlAdmin:phoneSync.removeAria", { cidr: network.cidr })}
                      onClick={() => void remove(network.id)}
                    >
                      <Trash2 size={15} />
                    </Button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {view && (
        <form
          id="phone-sync-address"
          className="phone-sync-address"
          onSubmit={(event) => { event.preventDefault(); if (addressValid) void saveAddress(false); }}
        >
          <h3>{t("controlAdmin:phoneSync.addressHeading")}</h3>
          <p className="section-description">{t("controlAdmin:phoneSync.addressDesc")}</p>
          <div className="phone-sync-address-fields">
            <Field label={t("controlAdmin:phoneSync.addressLabel")} value={address} onChange={setAddress} placeholder="http://192.168.2.10:4000" required={false} />
          </div>
          {!view.address && <p className="section-description">{t("controlAdmin:phoneSync.addressUnset")}</p>}
          {view.address && view.addressOutsideNetworks && (
            <MessageBox tone="warning" title={t("controlAdmin:phoneSync.outsideTitle")}>{t("controlAdmin:phoneSync.outsideBody")}</MessageBox>
          )}
          <div className="security-list-actions">
            <Button variant="primary" type="submit" disabled={savingAddress || !addressValid}>
              <Save size={16} />
              {savingAddress ? t("controlAdmin:phoneSync.saving") : t("controlAdmin:phoneSync.saveAddress")}
            </Button>
            {view.address && (
              <Button variant="secondary" onClick={() => void saveAddress(true)} disabled={savingAddress}>
                {t("controlAdmin:phoneSync.clearAddress")}
              </Button>
            )}
          </div>
        </form>
      )}

      {addOpen && (
        <Modal
          variant="card"
          title={t("controlAdmin:phoneSync.addTitle")}
          icon={<Smartphone size={22} />}
          className="security-form-modal"
          busy={adding}
          onClose={closeAdd}
          onSubmit={add}
        >
          <Field label={t("controlAdmin:security.cidrLabel")} value={cidr} onChange={setCidr} placeholder="192.168.1.0/24" />
          <Field
            label={t("controlAdmin:security.labelOptional")}
            value={label}
            onChange={setLabel}
            placeholder={t("controlAdmin:phoneSync.labelPlaceholder")}
            required={false}
          />
          {addError && <MessageBox tone="error" title={t("controlAdmin:security.addFailedTitle")}>{addError}</MessageBox>}
          <div className="modal-actions">
            <Button variant="secondary" onClick={closeAdd} disabled={adding} autoFocus>
              {t("common.cancel")}
            </Button>
            <Button variant="primary" type="submit" disabled={adding || !cidr.trim()}>
              <Plus size={16} />
              {adding ? t("controlAdmin:security.adding") : t("controlAdmin:phoneSync.add")}
            </Button>
          </div>
        </Modal>
      )}
    </section>
  );
}
