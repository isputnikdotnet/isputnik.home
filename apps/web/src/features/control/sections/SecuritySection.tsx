import { useState, useEffect, useCallback, type FormEvent } from "react";
import { ShieldCheck, Plus, Trash2, Ban } from "lucide-react";
import { api } from "../../../api";
import { Button } from "../../../shared/Button";
import { Field } from "../../../shared/Field";
import { MessageBox } from "../../../shared/MessageBox";
import { formatManagedDate } from "../../../shared/utils";

interface TrustedNetwork {
  id: string;
  cidr: string;
  label: string | null;
  createdAt: string;
}

interface BlockedIp {
  ip: string;
  reason: string | null;
  auto: boolean;
  createdAt: string;
  expiresAt: string | null;
}

interface SecurityPolicy {
  lockoutThreshold: number;
  lockoutMinutes: number;
  ipFailThreshold: number;
  ipFailWindowMinutes: number;
  ipAutoblockMinutes: number;
}

interface SecurityData {
  policy: SecurityPolicy;
  proxy: {
    trustProxyHops: number;
    configured: boolean;
    forwardedHeaderSeen: boolean;
  };
  trustedNetworks: TrustedNetwork[];
  blockedIps: BlockedIp[];
}

export function SecuritySection() {
  const [data, setData] = useState<SecurityData | null>(null);
  const [error, setError] = useState("");

  const [policyForm, setPolicyForm] = useState<SecurityPolicy | null>(null);
  const [savingPolicy, setSavingPolicy] = useState(false);
  const [policyError, setPolicyError] = useState("");
  const [policySaved, setPolicySaved] = useState(false);

  const [cidr, setCidr] = useState("");
  const [label, setLabel] = useState("");
  const [addingTrusted, setAddingTrusted] = useState(false);
  const [trustedError, setTrustedError] = useState("");

  const [ip, setIp] = useState("");
  const [reason, setReason] = useState("");
  const [blocking, setBlocking] = useState(false);
  const [blockError, setBlockError] = useState("");

  const load = useCallback(async () => {
    try {
      const fresh = await api<SecurityData>("/api/security");
      setData(fresh);
      setPolicyForm((prev) => prev ?? { ...fresh.policy });
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unable to load security settings");
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const savePolicy = async (event: FormEvent) => {
    event.preventDefault();
    if (!policyForm) return;
    setSavingPolicy(true);
    setPolicyError("");
    setPolicySaved(false);
    try {
      const res = await api<{ policy: SecurityPolicy }>("/api/security/policy", {
        method: "PATCH",
        body: JSON.stringify(policyForm)
      });
      setPolicyForm(res.policy);
      setPolicySaved(true);
      await load();
    } catch (err) {
      setPolicyError(err instanceof Error ? err.message : "Unable to save thresholds");
    } finally {
      setSavingPolicy(false);
    }
  };

  const addTrusted = async (event: FormEvent) => {
    event.preventDefault();
    setAddingTrusted(true);
    setTrustedError("");
    try {
      await api("/api/security/trusted-networks", {
        method: "POST",
        body: JSON.stringify({ cidr, label: label.trim() || undefined })
      });
      setCidr("");
      setLabel("");
      await load();
    } catch (err) {
      setTrustedError(err instanceof Error ? err.message : "Unable to add network");
    } finally {
      setAddingTrusted(false);
    }
  };

  const removeTrusted = async (id: string) => {
    setTrustedError("");
    try {
      await api(`/api/security/trusted-networks/${id}`, { method: "DELETE" });
      await load();
    } catch (err) {
      setTrustedError(err instanceof Error ? err.message : "Unable to remove network");
    }
  };

  const addBlock = async (event: FormEvent) => {
    event.preventDefault();
    setBlocking(true);
    setBlockError("");
    try {
      await api("/api/security/blocked-ips", {
        method: "POST",
        body: JSON.stringify({ ip, reason: reason.trim() || undefined })
      });
      setIp("");
      setReason("");
      await load();
    } catch (err) {
      setBlockError(err instanceof Error ? err.message : "Unable to block IP");
    } finally {
      setBlocking(false);
    }
  };

  const unblock = async (value: string) => {
    setBlockError("");
    try {
      await api(`/api/security/blocked-ips/${encodeURIComponent(value)}`, { method: "DELETE" });
      await load();
    } catch (err) {
      setBlockError(err instanceof Error ? err.message : "Unable to unblock IP");
    }
  };

  return (
    <>
      <div className="section-head">
        <div className="user-title-wrap">
          <span className="user-page-icon" aria-hidden="true">
            <ShieldCheck size={30} />
          </span>
          <div className="user-heading-copy">
            <p className="eyebrow">Application</p>
            <h1>Security</h1>
            <p className="section-description">Brute-force protection, trusted networks, and blocked IPs.</p>
          </div>
        </div>
      </div>

      {error && <MessageBox tone="error" title="Unable to load">{error}</MessageBox>}

      {data && (
        <>
          <section className="security-block" aria-labelledby="proxy-heading">
            <h2 id="proxy-heading">Reverse proxy</h2>
            <p className="section-description">
              Per-IP controls (rate limiting, auto-block) and trusted zones rely on the real client IP. Behind a proxy
              that's only correct when <code>TRUST_PROXY_HOPS</code> matches the number of proxies in front. It's an
              environment variable, read at startup.
            </p>
            <p>
              Current setting:{" "}
              <strong>
                {data.proxy.configured
                  ? `trusting ${data.proxy.trustProxyHops} proxy hop${data.proxy.trustProxyHops === 1 ? "" : "s"}`
                  : "not set — request IP is the direct connection"}
              </strong>
            </p>
            {data.proxy.forwardedHeaderSeen && !data.proxy.configured && (
              <MessageBox tone="warning" title="A proxy appears to be in front">
                Requests are arriving with an <code>X-Forwarded-For</code> header but <code>TRUST_PROXY_HOPS</code> isn't
                set, so every visitor looks like the proxy's IP — which breaks the controls below and lets anyone match a
                trusted network. Set it (usually <code>1</code>) and restart. See the exposing-to-the-internet guide.
              </MessageBox>
            )}
          </section>

          <MessageBox tone="info" title="Automatic protection is on">
            Accounts lock for {data.policy.lockoutMinutes} minutes after {data.policy.lockoutThreshold} failed sign-ins. An
            IP is auto-blocked for {data.policy.ipAutoblockMinutes} minutes after {data.policy.ipFailThreshold} failed
            sign-ins within {data.policy.ipFailWindowMinutes} minutes.
          </MessageBox>

          <section className="security-block" aria-labelledby="policy-heading">
            <h2 id="policy-heading">Protection thresholds</h2>
            <p className="section-description">Tune the lockout and IP auto-block. Changes apply immediately.</p>
            {policyForm && (
              <form className="security-add-form" onSubmit={savePolicy}>
                <label className="field">
                  <span>Lock account after (failed sign-ins)</span>
                  <input type="number" min={1} value={policyForm.lockoutThreshold} onChange={(event) => setPolicyForm({ ...policyForm, lockoutThreshold: Number(event.target.value) })} />
                </label>
                <label className="field">
                  <span>Lockout duration (minutes)</span>
                  <input type="number" min={1} value={policyForm.lockoutMinutes} onChange={(event) => setPolicyForm({ ...policyForm, lockoutMinutes: Number(event.target.value) })} />
                </label>
                <label className="field">
                  <span>Auto-block IP after (failed sign-ins)</span>
                  <input type="number" min={1} value={policyForm.ipFailThreshold} onChange={(event) => setPolicyForm({ ...policyForm, ipFailThreshold: Number(event.target.value) })} />
                </label>
                <label className="field">
                  <span>IP failure window (minutes)</span>
                  <input type="number" min={1} value={policyForm.ipFailWindowMinutes} onChange={(event) => setPolicyForm({ ...policyForm, ipFailWindowMinutes: Number(event.target.value) })} />
                </label>
                <label className="field">
                  <span>Auto-block duration (minutes)</span>
                  <input type="number" min={1} value={policyForm.ipAutoblockMinutes} onChange={(event) => setPolicyForm({ ...policyForm, ipAutoblockMinutes: Number(event.target.value) })} />
                </label>
                {policyError && <MessageBox tone="error" title="Unable to save">{policyError}</MessageBox>}
                {policySaved && <MessageBox tone="success" title="Saved">Thresholds updated.</MessageBox>}
                <Button variant="primary" type="submit" disabled={savingPolicy}>
                  {savingPolicy ? "Saving…" : "Save thresholds"}
                </Button>
              </form>
            )}
          </section>

          <section className="security-block" aria-labelledby="trusted-heading">
            <h2 id="trusted-heading">Trusted networks</h2>
            <p className="section-description">
              Requests from these ranges skip rate limits, account lockout, and two-factor — handy on your home LAN. Leave
              empty unless you need it.
            </p>
            <MessageBox tone="warning" title="Use with care">
              Only add ranges you fully control. If you run behind a reverse proxy, set <code>TRUST_PROXY_HOPS</code> first —
              otherwise every visitor can look like one private IP and bypass two-factor.
            </MessageBox>

            {data.trustedNetworks.length === 0 ? (
              <p className="management-empty">No trusted networks. Two-factor and lockout apply everywhere.</p>
            ) : (
              <div className="datagrid-wrap">
                <table className="datagrid">
                  <thead>
                    <tr>
                      <th>Range</th>
                      <th>Label</th>
                      <th>Added</th>
                      <th className="col-actions">Actions</th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.trustedNetworks.map((network) => (
                      <tr key={network.id}>
                        <td><code>{network.cidr}</code></td>
                        <td className="datagrid-muted">{network.label || "—"}</td>
                        <td className="datagrid-muted">{formatManagedDate(network.createdAt)}</td>
                        <td className="col-actions">
                          <Button
                            variant="icon"
                            danger
                            title="Remove trusted network"
                            aria-label={`Remove ${network.cidr}`}
                            onClick={() => removeTrusted(network.id)}
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

            <form className="security-add-form" onSubmit={addTrusted}>
              <Field label="IP or CIDR range" value={cidr} onChange={setCidr} placeholder="192.168.1.0/24" />
              <Field label="Label (optional)" value={label} onChange={setLabel} placeholder="Home LAN" required={false} />
              {trustedError && <MessageBox tone="error" title="Unable to add">{trustedError}</MessageBox>}
              <Button variant="primary" type="submit" disabled={addingTrusted || !cidr.trim()}>
                <Plus size={16} />
                {addingTrusted ? "Adding…" : "Add network"}
              </Button>
            </form>
          </section>

          <section className="security-block" aria-labelledby="blocked-heading">
            <h2 id="blocked-heading">Blocked IPs</h2>
            <p className="section-description">
              Blocked addresses are refused everywhere. Automatic blocks expire on their own; manual blocks stay until you
              remove them.
            </p>

            {data.blockedIps.length === 0 ? (
              <p className="management-empty">No blocked IPs.</p>
            ) : (
              <div className="datagrid-wrap">
                <table className="datagrid">
                  <thead>
                    <tr>
                      <th>IP</th>
                      <th>Reason</th>
                      <th>Type</th>
                      <th>Expires</th>
                      <th className="col-actions">Actions</th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.blockedIps.map((entry) => (
                      <tr key={entry.ip}>
                        <td><code>{entry.ip}</code></td>
                        <td className="datagrid-muted">{entry.reason || "—"}</td>
                        <td className="datagrid-muted">{entry.auto ? "Automatic" : "Manual"}</td>
                        <td className="datagrid-muted">{entry.expiresAt ? formatManagedDate(entry.expiresAt) : "Never"}</td>
                        <td className="col-actions">
                          <Button
                            variant="icon"
                            title="Unblock"
                            aria-label={`Unblock ${entry.ip}`}
                            onClick={() => unblock(entry.ip)}
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

            <form className="security-add-form" onSubmit={addBlock}>
              <Field label="IP address" value={ip} onChange={setIp} placeholder="203.0.113.10" />
              <Field label="Reason (optional)" value={reason} onChange={setReason} placeholder="Why it's blocked" required={false} />
              {blockError && <MessageBox tone="error" title="Unable to block">{blockError}</MessageBox>}
              <Button variant="danger" type="submit" disabled={blocking || !ip.trim()}>
                <Ban size={16} />
                {blocking ? "Blocking…" : "Block IP"}
              </Button>
            </form>
          </section>
        </>
      )}
    </>
  );
}
