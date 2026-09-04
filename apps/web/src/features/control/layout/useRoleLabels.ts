import { useTranslation } from "react-i18next";
import type { Role } from "./layout-model";

// Role names in the UI language, keyed both by role and by pattern token so the
// same map serves the role selects and `humanize`.
export function useRoleLabels(): Record<string, string> {
  const { t } = useTranslation("controlAdmin");
  const byRole: Record<Role, string> = {
    author: t("layout.roleAuthor"),
    series: t("layout.roleSeries"),
    position: t("layout.rolePosition"),
    title: t("layout.roleTitle"),
    narrator: t("layout.roleNarrator"),
    year: t("layout.roleYear"),
    publisher: t("layout.rolePublisher"),
    skip: t("layout.roleSkip")
  };
  return {
    ...byRole,
    "{author}": byRole.author, "{series}": byRole.series, "{position}": "01", "{title}": byRole.title,
    "{narrator}": byRole.narrator, "{year}": byRole.year, "{publisher}": byRole.publisher, "{ignore}": "…"
  };
}
