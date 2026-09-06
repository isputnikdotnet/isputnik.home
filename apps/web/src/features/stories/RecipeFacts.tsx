import { Clock, Users } from "lucide-react";
import { useTranslation } from "react-i18next";

type Translate = ReturnType<typeof useTranslation<["stories"]>>["t"];

/** Whole minutes as "45 min", "2 h", "2 h 10 min". */
function formatCookTime(minutes: number, t: Translate): string {
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  if (hours === 0) return t("stories:recipe.minutes", { minutes: rest });
  if (rest === 0) return t("stories:recipe.hours", { hours });
  return t("stories:recipe.hoursMinutes", { hours, minutes: rest });
}

/** True when the story has anything for RecipeFacts to draw. */
export function hasRecipeFacts(story: { servings: string | null; cookMinutes: number | null }): boolean {
  return Boolean(story.servings) || (story.cookMinutes != null && story.cookMinutes > 0);
}

// The recipe facts on a story head — "Serves 4–6 · 45 min" — beside the
// dateline and the place, the way a review shows its stars. Any story may
// carry them; nothing renders when neither is set. Servings is free text on
// purpose (docs/recipes-plan.md): it is read, never scaled.
export function RecipeFacts({
  servings,
  cookMinutes,
  leadingDot
}: {
  servings: string | null;
  cookMinutes: number | null;
  /** Something already sits before these in the row. */
  leadingDot?: boolean;
}) {
  const { t } = useTranslation(["stories"]);
  const parts: { key: string; icon: typeof Users; text: string }[] = [];
  // "4" and "4–6" read as "Serves 4–6"; anything wordier ("Makes 12", "one
  // big pot", "4 servings") is already a phrase and is shown as written.
  if (servings) {
    const bare = /^[\d\s.,–—-]+$/.test(servings);
    parts.push({ key: "serves", icon: Users, text: bare ? t("stories:recipe.serves", { servings }) : servings });
  }
  if (cookMinutes != null && cookMinutes > 0) parts.push({ key: "time", icon: Clock, text: formatCookTime(cookMinutes, t) });
  if (parts.length === 0) return null;
  return (
    <>
      {parts.map((part, index) => {
        const Icon = part.icon;
        return (
          <span key={part.key} className="story-recipe-fact-wrap">
            {(leadingDot || index > 0) && <span aria-hidden="true"> · </span>}
            <span className="story-recipe-fact"><Icon size={13} aria-hidden="true" /> {part.text}</span>
          </span>
        );
      })}
    </>
  );
}
