import { useState, useEffect, useCallback, type FormEvent } from "react";
import {
  AlertTriangle,
  Ban,
  CircleOff,
  Globe,
  Info,
  ListChecks,
  LockKeyhole,
  Plus,
  Save,
  ShieldCheck,
  Sparkles,
  Trash2,
  UserRound,
  type LucideIcon
} from "lucide-react";
import { api } from "../../../api";
import { Button } from "../../../shared/Button";
import { Field } from "../../../shared/Field";
import { MessageBox } from "../../../shared/MessageBox";
import { Modal } from "../../../shared/Modal";
import { repoFileUrl } from "../../../shared/links";
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

interface PasswordPolicy {
  minLength: number;
  requireComplexity: boolean;
}

interface SecurityData {
  policy: SecurityPolicy;
  proxy: {
    trustProxyHops: number;
    configured: boolean;
    forwardedHeaderSeen: boolean;
  };
  passwordPolicy: PasswordPolicy;
  trustedNetworks: TrustedNetwork[];
  blockedIps: BlockedIp[];
}

type SecurityTab = "overview" | "policies" | "trusted" | "blocked";

const SECURITY_TABS: { key: SecurityTab; label: string; icon: LucideIcon }[] = [
  { key: "overview", label: "Overview", icon: ShieldCheck },
  { key: "policies", label: "Policies", icon: ListChecks },
  { key: "trusted", label: "Trusted networks", icon: Globe },
  { key: "blocked", label: "Blocked IPs", icon: Ban }
];

export function SecuritySection() {
  const [data, setData] = useState<SecurityData | null>(null);
  const [error, setError] = useState("");
  const [activeTab, setActiveTab] = useState<SecurityTab>("overview");

  const [policyForm, setPolicyForm] = useState<SecurityPolicy | null>(null);
  const [savingPolicy, setSavingPolicy] = useState(false);
  const [policyError, setPolicyError] = useState("");
  const [policySaved, setPolicySaved] = useState(false);

  const [pwForm, setPwForm] = useState<PasswordPolicy | null>(null);
  const [savingPw, setSavingPw] = useState(false);
  const [pwError, setPwError] = useState("");
  const [pwSaved, setPwSaved] = useState(false);

  const [cidr, setCidr] = useState("");
  const [label, setLabel] = useState("");
  const [addingTrusted, setAddingTrusted] = useState(false);
  const [trustedOpen, setTrustedOpen] = useState(false);
  const [trustedError, setTrustedError] = useState("");

  const [ip, setIp] = useState("");
  const [reason, setReason] = useState("");
  const [blocking, setBlocking] = useState(false);
  const [blockOpen, setBlockOpen] = useState(false);
  const [blockError, setBlockError] = useState("");

  const load = useCallback(async () => {
    try {
      const fresh = await api<SecurityData>("/api/security");
      setData(fresh);
      setPolicyForm((prev) => prev ?? { ...fresh.policy });
      setPwForm((prev) => prev ?? { ...fresh.passwordPolicy });
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

  const savePwPolicy = async (event: FormEvent) => {
    event.preventDefault();
    if (!pwForm) return;
    setSavingPw(true);
    setPwError("");
    setPwSaved(false);
    try {
      const res = await api<{ passwordPolicy: PasswordPolicy }>("/api/security/password-policy", {
        method: "PATCH",
        body: JSON.stringify(pwForm)
      });
      setPwForm(res.passwordPolicy);
      setPwSaved(true);
      await load();
    } catch (err) {
      setPwError(err instanceof Error ? err.message : "Unable to save password policy");
    } finally {
      setSavingPw(false);
    }
  };

  const closeTrustedModal = () => {
    setTrustedOpen(false);
    setCidr("");
    setLabel("");
    setTrustedError("");
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
      setTrustedOpen(false);
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

  const closeBlockModal = () => {
    setBlockOpen(false);
    setIp("");
    setReason("");
    setBlockError("");
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
      setBlockOpen(false);
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
          <div className="control-tabs security-tabs" role="tablist" aria-label="Security sections">
            {SECURITY_TABS.map((tab) => {
              const selected = activeTab === tab.key;
              const Icon = tab.icon;
              return (
                <Button
                  key={tab.key}
                  variant="text"
                  className={`security-tab${selected ? " active" : ""}`}
                  role="tab"
                  aria-selected={selected}
                  aria-controls={`security-panel-${tab.key}`}
                  id={`security-tab-${tab.key}`}
                  onClick={() => setActiveTab(tab.key)}
                >
                  <Icon className="security-tab-icon" size={18} aria-hidden="true" />
                  <span>{tab.label}</span>
                </Button>
              );
            })}
          </div>

          <div className="security-tab-panels">
            <div
              className="security-tab-panel"
              role="tabpanel"
              id="security-panel-overview"
              aria-labelledby="security-tab-overview"
              hidden={activeTab !== "overview"}
            >
              <section className="security-overview-dashboard" aria-label="Security overview">
                <div className="security-overview-cards">
                  <article className="security-overview-card">
                    <span
                      className={`security-overview-card-icon ${
                        data.proxy.forwardedHeaderSeen && !data.proxy.configured
                          ? "warning"
                          : data.proxy.configured
                            ? "success"
                            : "info"
                      }`}
                      aria-hidden="true"
                    >
                      <UserRound size={26} />
                    </span>
                    <div className="security-overview-card-copy">
                      <span className="security-overview-card-label">IP mode</span>
                      <strong>
                        {data.proxy.forwardedHeaderSeen && !data.proxy.configured
                          ? "Proxy attention"
                          : data.proxy.configured
                            ? "Proxy trust configured"
                            : "Direct IP"}
                      </strong>
                      <span>
                        {data.proxy.configured
                          ? `${data.proxy.trustProxyHops} proxy hop${data.proxy.trustProxyHops === 1 ? "" : "s"} trusted`
                          : "Proxy hops not set"}
                      </span>
                    </div>
                  </article>

                  <article className="security-overview-card">
                    <span className="security-overview-card-icon info" aria-hidden="true">
                      <LockKeyhole size={26} />
                    </span>
                    <div className="security-overview-card-copy">
                      <span className="security-overview-card-label">Lockout</span>
                      <strong>{data.policy.lockoutMinutes} min</strong>
                      <span>{data.policy.lockoutThreshold} failed attempts</span>
                    </div>
                  </article>

                  <article className="security-overview-card">
                    <span className="security-overview-card-icon info" aria-hidden="true">
                      <Globe size={26} />
                    </span>
                    <div className="security-overview-card-copy">
                      <span className="security-overview-card-label">IP auto-block</span>
                      <strong>{data.policy.ipAutoblockMinutes} min</strong>
                      <span>{data.policy.ipFailThreshold} failed in {data.policy.ipFailWindowMinutes} min</span>
                    </div>
                  </article>

                  <article className="security-overview-card">
                    <span className="security-overview-card-icon success" aria-hidden="true">
                      <ShieldCheck size={26} />
                    </span>
                    <div className="security-overview-card-copy">
                      <span className="security-overview-card-label">Status</span>
                      <strong className="security-overview-success">Protected</strong>
                      <span>Automatic protection on</span>
                    </div>
                  </article>
                </div>

                <section
                  className={`security-dashboard-message ${
                    data.proxy.forwardedHeaderSeen && !data.proxy.configured
                      ? "warning"
                      : data.proxy.configured
                        ? "success"
                        : "info"
                  }`}
                  aria-labelledby="proxy-status-heading"
                >
                  <span className="security-dashboard-message-icon" aria-hidden="true">
                    {data.proxy.forwardedHeaderSeen && !data.proxy.configured ? (
                      <AlertTriangle size={26} />
                    ) : data.proxy.configured ? (
                      <ShieldCheck size={26} />
                    ) : (
                      <Info size={26} />
                    )}
                  </span>
                  <div>
                    <h2 id="proxy-status-heading">
                      {data.proxy.forwardedHeaderSeen && !data.proxy.configured
                        ? "Proxy trust needs attention"
                        : data.proxy.configured
                          ? "Proxy trust is configured"
                          : "Using direct connection IPs"}
                    </h2>
                    {data.proxy.forwardedHeaderSeen && !data.proxy.configured ? (
                      <p>
                        Requests include <code>X-Forwarded-For</code>, but <code>TRUST_PROXY_HOPS</code> is not set.
                        Every visitor may look like the proxy IP, which can break rate limits and trusted networks.
                      </p>
                    ) : data.proxy.configured ? (
                      <p>
                        Trusting {data.proxy.trustProxyHops} proxy hop{data.proxy.trustProxyHops === 1 ? "" : "s"}{" "}
                        before reading the forwarded client IP.
                      </p>
                    ) : (
                      <>
                        <p>
                          <code>TRUST_PROXY_HOPS</code> is not set, so security checks use the direct connection IP.
                          This is fine when the app is not behind a proxy.
                        </p>
                        <p className="security-help-link">
                          <a
                            href={repoFileUrl("docs/users/exposing-to-the-internet.md")}
                            target="_blank"
                            rel="noreferrer"
                          >
                            Read the exposing-to-the-internet guide
                          </a>
                        </p>
                      </>
                    )}
                  </div>
                </section>

                <section className="security-dashboard-message success" aria-labelledby="protection-status-heading">
                  <span className="security-dashboard-message-icon" aria-hidden="true">
                    <ShieldCheck size={26} />
                  </span>
                  <div>
                    <h2 id="protection-status-heading">Automatic protection is on</h2>
                    <p>
                      Accounts lock for {data.policy.lockoutMinutes} minutes after {data.policy.lockoutThreshold}{" "}
                      failed sign-ins.
                    </p>
                    <p>
                      An IP is auto-blocked for {data.policy.ipAutoblockMinutes} minutes after{" "}
                      {data.policy.ipFailThreshold} failed sign-ins within {data.policy.ipFailWindowMinutes} minutes.
                    </p>
                  </div>
                </section>
              </section>
            </div>

            <div
              className="security-tab-panel"
              role="tabpanel"
              id="security-panel-policies"
              aria-labelledby="security-tab-policies"
              hidden={activeTab !== "policies"}
            >
              <section className="security-block security-policy-card" aria-labelledby="policy-heading">
                <div className="security-policy-card-head">
                  <span className="security-policy-icon" aria-hidden="true">
                    <ShieldCheck size={24} />
                  </span>
                  <div>
                    <h2 id="policy-heading">Protection thresholds</h2>
                    <p className="section-description">Tune the lockout and IP auto-block. Changes apply immediately.</p>
                  </div>
                </div>
                {policyForm && (
                  <form className="security-policy-form" onSubmit={savePolicy}>
                    <label className="security-setting-row">
                      <span className="security-setting-copy">
                        <span className="security-setting-label">Lock account after (failed sign-ins)</span>
                        <span className="security-setting-help">Number of consecutive failed sign-in attempts.</span>
                      </span>
                      <input
                        type="number"
                        min={1}
                        value={policyForm.lockoutThreshold}
                        onChange={(event) =>
                          setPolicyForm({ ...policyForm, lockoutThreshold: Number(event.target.value) })
                        }
                      />
                    </label>
                    <label className="security-setting-row">
                      <span className="security-setting-copy">
                        <span className="security-setting-label">Lockout duration (minutes)</span>
                        <span className="security-setting-help">Time the account remains locked.</span>
                      </span>
                      <input
                        type="number"
                        min={1}
                        value={policyForm.lockoutMinutes}
                        onChange={(event) =>
                          setPolicyForm({ ...policyForm, lockoutMinutes: Number(event.target.value) })
                        }
                      />
                    </label>
                    <label className="security-setting-row">
                      <span className="security-setting-copy">
                        <span className="security-setting-label">Auto-block IP after (failed sign-ins)</span>
                        <span className="security-setting-help">Number of failed sign-ins before an IP is blocked.</span>
                      </span>
                      <input
                        type="number"
                        min={1}
                        value={policyForm.ipFailThreshold}
                        onChange={(event) =>
                          setPolicyForm({ ...policyForm, ipFailThreshold: Number(event.target.value) })
                        }
                      />
                    </label>
                    <label className="security-setting-row">
                      <span className="security-setting-copy">
                        <span className="security-setting-label">IP failure window (minutes)</span>
                        <span className="security-setting-help">Time window to count failed sign-ins from the same IP.</span>
                      </span>
                      <input
                        type="number"
                        min={1}
                        value={policyForm.ipFailWindowMinutes}
                        onChange={(event) =>
                          setPolicyForm({ ...policyForm, ipFailWindowMinutes: Number(event.target.value) })
                        }
                      />
                    </label>
                    <label className="security-setting-row">
                      <span className="security-setting-copy">
                        <span className="security-setting-label">Auto-block duration (minutes)</span>
                        <span className="security-setting-help">Time the IP remains blocked.</span>
                      </span>
                      <input
                        type="number"
                        min={1}
                        value={policyForm.ipAutoblockMinutes}
                        onChange={(event) =>
                          setPolicyForm({ ...policyForm, ipAutoblockMinutes: Number(event.target.value) })
                        }
                      />
                    </label>
                    {policyError && <MessageBox tone="error" title="Unable to save">{policyError}</MessageBox>}
                    {policySaved && <MessageBox tone="success" title="Saved">Thresholds updated.</MessageBox>}
                    <div className="security-policy-actions">
                      <Button
                        variant="primary"
                        className="security-save-button"
                        type="submit"
                        disabled={savingPolicy}
                      >
                        <Save size={16} />
                        {savingPolicy ? "Saving…" : "Save thresholds"}
                      </Button>
                    </div>
                  </form>
                )}
              </section>

              <section className="security-block security-policy-card" aria-labelledby="pw-heading">
                <div className="security-policy-card-head">
                  <span className="security-policy-icon" aria-hidden="true">
                    <LockKeyhole size={24} />
                  </span>
                  <div>
                    <h2 id="pw-heading">Password policy</h2>
                    <p className="section-description">
                      Applies when a password is set or changed. Existing passwords keep working.
                    </p>
                  </div>
                </div>
                {pwForm && (
                  <form className="security-policy-form" onSubmit={savePwPolicy}>
                    <label className="security-setting-row">
                      <span className="security-setting-copy">
                        <span className="security-setting-label">Minimum length</span>
                        <span className="security-setting-help">Minimum number of characters.</span>
                      </span>
                      <input
                        type="number"
                        min={8}
                        max={128}
                        value={pwForm.minLength}
                        onChange={(event) => setPwForm({ ...pwForm, minLength: Number(event.target.value) })}
                      />
                    </label>
                    <label className="security-setting-row security-setting-row-checkbox">
                      <input
                        type="checkbox"
                        checked={pwForm.requireComplexity}
                        onChange={(event) => setPwForm({ ...pwForm, requireComplexity: event.target.checked })}
                      />
                      <span className="security-setting-copy">
                        <span className="security-setting-label">
                          Require a mix of letters, numbers, and symbols (at least 3 of 4)
                        </span>
                        <span className="security-setting-help">
                          Improve password strength by requiring character variety.
                        </span>
                      </span>
                    </label>
                    {pwError && <MessageBox tone="error" title="Unable to save">{pwError}</MessageBox>}
                    {pwSaved && <MessageBox tone="success" title="Saved">Password policy updated.</MessageBox>}
                    <div className="security-policy-actions">
                      <Button variant="primary" className="security-save-button" type="submit" disabled={savingPw}>
                        <Save size={16} />
                        {savingPw ? "Saving…" : "Save password policy"}
                      </Button>
                    </div>
                  </form>
                )}
              </section>
            </div>

            <div
              className="security-tab-panel"
              role="tabpanel"
              id="security-panel-trusted"
              aria-labelledby="security-tab-trusted"
              hidden={activeTab !== "trusted"}
            >
              <section className="security-block security-network-view" aria-labelledby="trusted-heading">
                <div className="security-network-head">
                  <h2 id="trusted-heading">Trusted networks</h2>
                  <p className="section-description">
                    Requests from these ranges skip rate limits, account lockout, and two-factor — handy on your home
                    LAN. Leave empty unless you need it.
                  </p>
                </div>

                <MessageBox tone="warning" title="Use with care" className="security-network-callout">
                  Only add ranges you fully control. If you run behind a reverse proxy, set{" "}
                  <code>TRUST_PROXY_HOPS</code> first — otherwise every visitor can look like one private IP and bypass
                  two-factor.
                </MessageBox>

                <div className="security-list-actions">
                  <Button
                    variant="primary"
                    onClick={() => {
                      setTrustedError("");
                      setTrustedOpen(true);
                    }}
                  >
                    <Plus size={16} />
                    Add network
                  </Button>
                </div>

                {trustedError && !trustedOpen && (
                  <MessageBox tone="error" title="Unable to update trusted networks">{trustedError}</MessageBox>
                )}

                {data.trustedNetworks.length === 0 ? (
                  <div className="security-network-empty trusted">
                    <div className="security-network-empty-visual" aria-hidden="true">
                      <Sparkles className="security-empty-spark spark-a" size={18} />
                      <ShieldCheck className="security-empty-main-icon" size={72} />
                      <Globe className="security-empty-spark spark-b" size={18} />
                    </div>
                    <div className="security-network-empty-copy">
                      <h3>No trusted networks yet</h3>
                      <p>
                        When you add a network range here, requests from those IPs will skip rate limits, account
                        lockout, and two-factor.
                      </p>
                      <div className="security-network-empty-note">
                        <ShieldCheck size={18} aria-hidden="true" />
                        <span>Two-factor and lockout apply everywhere.</span>
                      </div>
                    </div>
                  </div>
                ) : (
                  <div className="datagrid-wrap security-network-table">
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
                            <td>
                              <code>{network.cidr}</code>
                            </td>
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
              </section>
            </div>

            <div
              className="security-tab-panel"
              role="tabpanel"
              id="security-panel-blocked"
              aria-labelledby="security-tab-blocked"
              hidden={activeTab !== "blocked"}
            >
              <section className="security-block security-network-view" aria-labelledby="blocked-heading">
                <div className="security-network-head">
                  <h2 id="blocked-heading">Blocked IPs</h2>
                  <p className="section-description">
                    Blocked addresses are refused everywhere. Automatic blocks expire on their own; manual blocks stay
                    until you remove them.
                  </p>
                </div>

                <div className="security-list-actions">
                  <Button
                    variant="danger"
                    onClick={() => {
                      setBlockError("");
                      setBlockOpen(true);
                    }}
                  >
                    <Ban size={16} />
                    Block IP
                  </Button>
                </div>

                {blockError && !blockOpen && (
                  <MessageBox tone="error" title="Unable to update blocked IPs">{blockError}</MessageBox>
                )}

                {data.blockedIps.length === 0 ? (
                  <div className="security-network-empty blocked">
                    <div className="security-network-empty-visual" aria-hidden="true">
                      <Sparkles className="security-empty-spark spark-a" size={18} />
                      <CircleOff className="security-empty-main-icon" size={72} />
                      <ShieldCheck className="security-empty-spark spark-b" size={18} />
                    </div>
                    <div className="security-network-empty-copy">
                      <h3>No blocked IPs yet</h3>
                      <p>
                        Manually blocked addresses will appear here. Automatic blocks also show up while they are active.
                      </p>
                      <div className="security-network-empty-note">
                        <ShieldCheck size={18} aria-hidden="true" />
                        <span>No addresses are currently refused manually.</span>
                      </div>
                    </div>
                  </div>
                ) : (
                  <div className="datagrid-wrap security-network-table">
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
                            <td>
                              <code>{entry.ip}</code>
                            </td>
                            <td className="datagrid-muted">{entry.reason || "—"}</td>
                            <td className="datagrid-muted">{entry.auto ? "Automatic" : "Manual"}</td>
                            <td className="datagrid-muted">
                              {entry.expiresAt ? formatManagedDate(entry.expiresAt) : "Never"}
                            </td>
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
              </section>
            </div>
          </div>

          {trustedOpen && (
            <Modal
              variant="card"
              title="Add trusted network"
              icon={<Plus size={22} />}
              className="security-form-modal"
              busy={addingTrusted}
              onClose={closeTrustedModal}
              onSubmit={addTrusted}
            >
              <Field label="IP or CIDR range" value={cidr} onChange={setCidr} placeholder="192.168.1.0/24" />
              <Field
                label="Label (optional)"
                value={label}
                onChange={setLabel}
                placeholder="Home LAN"
                required={false}
              />
              {trustedError && <MessageBox tone="error" title="Unable to add">{trustedError}</MessageBox>}
              <div className="modal-actions">
                <Button variant="secondary" onClick={closeTrustedModal} disabled={addingTrusted} autoFocus>
                  Cancel
                </Button>
                <Button variant="primary" type="submit" disabled={addingTrusted || !cidr.trim()}>
                  <Plus size={16} />
                  {addingTrusted ? "Adding…" : "Add network"}
                </Button>
              </div>
            </Modal>
          )}

          {blockOpen && (
            <Modal
              variant="card"
              title="Block IP address"
              icon={<Ban size={22} />}
              className="security-form-modal"
              busy={blocking}
              onClose={closeBlockModal}
              onSubmit={addBlock}
            >
              <Field label="IP address" value={ip} onChange={setIp} placeholder="203.0.113.10" />
              <Field
                label="Reason (optional)"
                value={reason}
                onChange={setReason}
                placeholder="Why it's blocked"
                required={false}
              />
              {blockError && <MessageBox tone="error" title="Unable to block">{blockError}</MessageBox>}
              <div className="modal-actions">
                <Button variant="secondary" onClick={closeBlockModal} disabled={blocking} autoFocus>
                  Cancel
                </Button>
                <Button variant="danger" type="submit" disabled={blocking || !ip.trim()}>
                  <Ban size={16} />
                  {blocking ? "Blocking…" : "Block IP"}
                </Button>
              </div>
            </Modal>
          )}
        </>
      )}
    </>
  );
}
