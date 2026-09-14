import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { X } from "lucide-react";
import { Button } from "../../../../shared/Button";
import { SelectField } from "../../../../shared/SelectField";
import { countryLabel, type PlacesView } from "./map-settings";

// "Every village in…" on the Photo place names card. The place list holds towns of
// 500+ people; a country chosen here gets every village too — for typing a place
// in the family tree only, never for naming photos. Choosing is a draft: nothing
// changes until Save, which asks first, because it rebuilds the place list.

export function VillageCountries({
  places,
  disabled,
  onSave
}: {
  places: PlacesView;
  disabled: boolean;
  onSave: (countries: string[]) => void;
}) {
  const { t, i18n } = useTranslation(["common", "controlAdmin"]);
  const wanted = useMemo(() => places.villageCountriesWanted ?? [], [places.villageCountriesWanted]);
  const [draft, setDraft] = useState<string[]>(wanted);
  useEffect(() => setDraft(wanted), [wanted]);

  const label = (code: string) => countryLabel(code, i18n.language);
  const byName = (a: string, b: string) => label(a).localeCompare(label(b), i18n.language);
  const offered = (places.countries ?? []).filter((code) => !draft.includes(code)).sort(byName);
  const dirty = [...draft].sort().join(",") !== [...wanted].sort().join(",");
  const built = places.villageCountries ?? [];
  const waiting = !dirty && !places.build.running && [...built].sort().join(",") !== [...wanted].sort().join(",");

  return (
    <div className="map-feature-part village-countries">
      <div className="village-countries-head">
        <strong>{t("controlAdmin:mapFeatures.villagesTitle")}</strong>
        <small className="muted">{t("controlAdmin:mapFeatures.villagesHint")}</small>
      </div>
      <div className="village-countries-chips">
        {draft.length === 0 && <span className="muted">{t("controlAdmin:mapFeatures.villagesNone")}</span>}
        {[...draft].sort(byName).map((code) => (
          <Button
            key={code}
            variant="chip"
            className="village-country-chip"
            disabled={disabled}
            aria-label={t("controlAdmin:mapFeatures.villagesRemove", { name: label(code) })}
            title={t("controlAdmin:mapFeatures.villagesRemove", { name: label(code) })}
            onClick={() => setDraft(draft.filter((other) => other !== code))}
          >
            <span>{label(code)}</span>
            <X size={13} aria-hidden="true" />
          </Button>
        ))}
      </div>
      <div className="map-feature-row">
        <SelectField
          label={t("controlAdmin:mapFeatures.villagesAdd")}
          hideLabel
          compact
          value=""
          disabled={disabled || offered.length === 0}
          options={[
            { value: "", label: t("controlAdmin:mapFeatures.villagesAdd") },
            ...offered.map((code) => ({ value: code, label: label(code) }))
          ]}
          onChange={(code) => { if (code) setDraft([...draft, code]); }}
        />
        {dirty && (
          <>
            <Button variant="primary" compact disabled={disabled} onClick={() => onSave(draft)}>
              {t("controlAdmin:mapFeatures.villagesSave")}
            </Button>
            <Button variant="text" compact disabled={disabled} onClick={() => setDraft(wanted)}>
              {t("common.cancel")}
            </Button>
          </>
        )}
      </div>
      {!dirty && (places.villages ?? 0) > 0 && (
        <span className="map-feature-status is-ok">
          {t("controlAdmin:mapFeatures.villagesBuilt", {
            count: places.villages ?? 0,
            number: (places.villages ?? 0).toLocaleString(),
            countries: built.map(label).join(", ")
          })}
        </span>
      )}
      {waiting && <span className="map-feature-status">{t("controlAdmin:mapFeatures.villagesWaiting")}</span>}
    </div>
  );
}
