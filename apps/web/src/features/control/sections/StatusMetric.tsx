import i18n from "../../../i18n";

export function formatHours(seconds: number) {
  if (seconds <= 0) return i18n.t("controlAdmin:statusMetric.hours", { value: 0 });
  const hours = seconds / 3600;
  const value = hours >= 100 ? Math.round(hours).toLocaleString() : hours.toFixed(hours >= 10 ? 1 : 2);
  return i18n.t("controlAdmin:statusMetric.hours", { value });
}
