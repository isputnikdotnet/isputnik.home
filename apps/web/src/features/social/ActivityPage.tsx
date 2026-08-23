import { useEffect, useState } from "react";
import { Users } from "lucide-react";
import { api, type PublicUser } from "../../api";
import { DashboardShell } from "../../app/DashboardShell";
import { UserAreaNav } from "../library/UserAreaNav";
import { MessageBox } from "../../shared/MessageBox";
import { ActivityList, type ActivityItem } from "./ActivityList";

// The longer version of the Home row. Same list, more of it — the Home row is
// the glance, this is the "what did I miss".

export function ActivityPage({ user, logout }: { user: PublicUser; logout: () => Promise<void> }) {
  const [items, setItems] = useState<ActivityItem[] | null>(null);
  const [error, setError] = useState("");

  useEffect(() => {
    api<{ items: ActivityItem[] }>("/api/social/activity?limit=50")
      .then((payload) => setItems(payload.items))
      .catch((err) => setError(err instanceof Error ? err.message : "Unable to load what's been happening"));
  }, []);

  return (
    <DashboardShell active="user" user={user} logout={logout} sideNav={<UserAreaNav active="activity" />}>
      <section className="work-area audiobook-area">
        <div className="section-head audiobook-head">
          <div>
            <p className="eyebrow">Family</p>
            <h1>Around the house</h1>
          </div>
        </div>

        {error && <MessageBox tone="error" title="Unable to load">{error}</MessageBox>}

        {items && items.length === 0 && (
          <div className="inbox-empty">
            <Users size={32} aria-hidden />
            <p>Nothing yet.</p>
            <p className="inbox-empty-hint">
              Notes, albums, slideshows and new people in the family tree show up here as the
              household adds them. Your own doings aren’t listed — you already know about those.
            </p>
          </div>
        )}

        {items && items.length > 0 && <ActivityList items={items} />}
      </section>
    </DashboardShell>
  );
}
