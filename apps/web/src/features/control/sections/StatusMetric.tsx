import i18n from "../../../i18n";
import { formatNumber } from "../../../shared/dates";

export function formatHours(seconds: number) {
  if (seconds <= 0) return i18n.t("controlAdmin:statusMetric.hours", { value: 0 });
  const hours = seconds / 3600;
  const value = hours >= 100 ? formatNumber(Math.round(hours)) : hours.toFixed(hours >= 10 ? 1 : 2);
  return i18n.t("controlAdmin:statusMetric.hours", { value });
}
