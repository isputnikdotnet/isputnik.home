import { useEffect, useMemo, useState, type FormEvent } from "react";
import { useTranslation } from "react-i18next";
import { Filter } from "lucide-react";
import { api } from "../../../../api";
import { Button } from "../../../../shared/Button";
import { ChoiceGroup, type Choice } from "../../../../shared/ChoiceGroup";
import { MessageBox } from "../../../../shared/MessageBox";
import { Modal } from "../../../../shared/Modal";
import { countryName } from "../../../../shared/utils";
import type { ManagedUser } from "../../types";
import { COUNTRY_CENTROIDS } from "./countryCentroids";
import type { SignInsScopeParams } from "./SignInsSection";

// The manual way into a Sign-ins scope. The dive arrows cover "this thing I can
// see"; this form covers "the thing I'm looking for" — a country with no rows on
// screen right now, an address pasted from an email alert, a person picked by
// name. One scope at a time, same as the server: the choice group makes that
// contract visible instead of letting five fields silently fight.

type FilterKind = "all" | "country" | "place" | "ip" | "user";

// The map's own country table doubles as the picker's list: every code the
// location database can answer with, named in the reader's language. Compound
// territory codes ("um-fq") are the SVG set's, not ISO — the database never
// returns them, so they'd be dead options.
const COUNTRY_OPTIONS = Object.keys(COUNTRY_CENTROIDS)
  .filter((code) => /^[a-z]{2}$/.test(code))
  .map((code) => ({ code: code.toUpperCase(), name: countryName(code.toUpperCase()) ?? code.toUpperCase() }))
  .sort((a, b) => a.name.localeCompare(b.name));

function kindOf(scope: SignInsScopeParams): FilterKind {
  if (scope.ip !== undefined) return "ip";
  if (scope.user !== undefined) return "user";
  if (scope.country !== undefined) return scope.city || scope.region ? "place" : "country";
  return "all";
}

export function SignInsFilterModal({
  scope,
  onApply,
  onClose
}: {
  scope: SignInsScopeParams;
  onApply: (next: SignInsScopeParams) => void;
  onClose: () => void;
}) {
  const { t } = useTranslation(["common", "controlDash"]);
  const KIND_OPTIONS: Choice<FilterKind>[] = [
    { value: "all", label: t("controlDash:signInsFilter.kindAll"), description: t("controlDash:signInsFilter.kindAllNote") },
    { value: "country", label: t("controlDash:signInsFilter.kindCountry"), description: t("controlDash:signInsFilter.kindCountryNote") },
    { value: "place", label: t("controlDash:signInsFilter.kindPlace"), description: t("controlDash:signInsFilter.kindPlaceNote") },
    { value: "ip", label: t("controlDash:signInsFilter.kindIp"), description: t("controlDash:signInsFilter.kindIpNote") },
    { value: "user", label: t("controlDash:signInsFilter.kindUser"), description: t("controlDash:signInsFilter.kindUserNote") }
  ];
  const [kind, setKind] = useState<FilterKind>(() => kindOf(scope));
  const [country, setCountry] = useState(scope.country ?? "");
  const [region, setRegion] = useState(scope.region ?? "");
  const [city, setCity] = useState(scope.city ?? "");
  const [ip, setIp] = useState(scope.ip ?? "");
  const [userId, setUserId] = useState(scope.user ?? "");
  const [users, setUsers] = useState<ManagedUser[] | null>(null);
  const [error, setError] = useState("");

  // The people list is only needed for one of the five choices, but it is small
  // and the modal is already open — fetching up front keeps the Person option
  // from stuttering when picked.
  useEffect(() => {
    api<{ users: ManagedUser[] }>("/api/users")
      .then((payload) => setUsers(payload.users))
      .catch((err) => setError(err instanceof Error ? err.message : t("controlDash:signInsFilter.membersFailed")));
  }, []);

  const ready = useMemo(() => {
    if (kind === "all") return true;
    if (kind === "country") return country !== "";
    if (kind === "place") return country !== "" && (city.trim() !== "" || region.trim() !== "");
    if (kind === "ip") return ip.trim() !== "";
    return userId !== "";
  }, [kind, country, region, city, ip, userId]);

  const apply = (event: FormEvent) => {
    event.preventDefault();
    if (!ready) return;
    if (kind === "all") return onApply({});
    if (kind === "country") return onApply({ country });
    if (kind === "place") {
      // Blank refinements are omitted rather than sent as "": to the server an
      // empty string means "the rows whose region is unknown", which is a thing
      // the Locations arrows ask for but a hand-filled form never means.
      const next: SignInsScopeParams = { country };
      if (region.trim() !== "") next.region = region.trim();
      if (city.trim() !== "") next.city = city.trim();
      return onApply(next);
    }
    if (kind === "ip") return onApply({ ip: ip.trim() });
    return onApply({ user: userId });
  };

  return (
    <Modal
      title={t("controlDash:signInsFilter.title")}
      icon={<Filter size={20} />}
      onClose={onClose}
      onSubmit={apply}
      className="signins-filter-modal"
    >
      {error && <MessageBox tone="error" title={t("controlDash:signInsFilter.loadFailedTitle")}>{error}</MessageBox>}

      <ChoiceGroup legend={t("controlDash:signInsFilter.legend")} options={KIND_OPTIONS} value={kind} onChange={setKind} />

      {(kind === "country" || kind === "place") && (
        <label className="field">
          <span>{t("controlDash:signInsFilter.country")}</span>
          <select value={country} onChange={(event) => setCountry(event.target.value)}>
            <option value="">{t("controlDash:signInsFilter.chooseCountry")}</option>
            {COUNTRY_OPTIONS.map((option) => (
              <option key={option.code} value={option.code}>{option.name}</option>
            ))}
          </select>
        </label>
      )}

      {kind === "place" && (
        <>
          <label className="field">
            <span>{t("controlDash:signInsFilter.townOrCity")}</span>
            <input
              type="text"
              value={city}
              maxLength={120}
              placeholder={t("controlDash:signInsFilter.cityPlaceholder")}
              onChange={(event) => setCity(event.target.value)}
            />
          </label>
          <label className="field">
            <span>{t("controlDash:signInsFilter.region")} <span className="muted">{t("controlDash:signInsFilter.optional")}</span></span>
            <input
              type="text"
              value={region}
              maxLength={120}
              placeholder={t("controlDash:signInsFilter.regionPlaceholder")}
              onChange={(event) => setRegion(event.target.value)}
            />
          </label>
          <p className="muted signins-filter-hint">{t("controlDash:signInsFilter.spellingHint")}</p>
        </>
      )}

      {kind === "ip" && (
        <label className="field">
          <span>{t("controlDash:signInsFilter.ipAddress")}</span>
          <input
            type="text"
            value={ip}
            maxLength={60}
            placeholder="203.0.113.7"
            autoComplete="off"
            spellCheck={false}
            onChange={(event) => setIp(event.target.value)}
          />
        </label>
      )}

      {kind === "user" && (
        <label className="field">
          <span>{t("controlDash:signInsFilter.person")}</span>
          <select value={userId} disabled={users === null} onChange={(event) => setUserId(event.target.value)}>
            <option value="">{users === null ? t("controlDash:signInsFilter.loadingMembers") : t("controlDash:signInsFilter.choosePerson")}</option>
            {(users ?? []).map((user) => (
              <option key={user.id} value={user.id}>
                {user.displayName} — {user.email}
              </option>
            ))}
          </select>
        </label>
      )}

      <div className="modal-actions">
        <Button variant="secondary" onClick={onClose}>{t("common.cancel")}</Button>
        <Button variant="primary" type="submit" disabled={!ready}>{t("controlDash:signInsFilter.apply")}</Button>
      </div>
    </Modal>
  );
}
