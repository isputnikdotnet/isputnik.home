import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { api } from "../../../../api";
import type { IpReputationEntry } from "../../types";

// Reputation is enrichment, never a reason to phone home: the sign-ins table
// reads what earlier AbuseIPDB lookups already cached, and an address nobody has
// asked about shows a Check button rather than being sent anywhere on its own.
export function useIpReputation(addresses: (string | null)[]) {
  const { t } = useTranslation(["common", "controlDash"]);
  const [byIp, setByIp] = useState<Record<string, IpReputationEntry>>({});
  const [configured, setConfigured] = useState(false);
  const [checking, setChecking] = useState<string | null>(null);
  const [error, setError] = useState("");
  const key = addresses.filter(Boolean).join(",");

  useEffect(() => {
    const ips = [...new Set(key.split(",").filter(Boolean))];
    const query = new URLSearchParams();
    ips.forEach((ip) => query.append("ip", ip));
    api<{ configured: boolean; reputation: IpReputationEntry[] }>(`/api/security/ip-reputation?${query}`)
      .then((payload) => {
        setConfigured(payload.configured);
        setByIp((current) => {
          const next = { ...current };
          payload.reputation.forEach((row) => {
            next[row.ip] = row;
          });
          return next;
        });
      })
      .catch(() => setConfigured(false));
  }, [key]);

  const check = useCallback(async (ip: string) => {
    setChecking(ip);
    setError("");
    try {
      const payload = await api<{ reputation: IpReputationEntry }>(
        `/api/security/ip-reputation/${encodeURIComponent(ip)}/check`,
        { method: "POST" }
      );
      setByIp((current) => ({ ...current, [ip]: payload.reputation }));
    } catch (err) {
      setError(err instanceof Error ? err.message : t("controlDash:signIns.lookupFailed"));
    } finally {
      setChecking(null);
    }
  }, []);

  return { byIp, configured, checking, error, check };
}
