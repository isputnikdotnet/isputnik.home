import { useState, useCallback, useEffect } from "react";
import { api, type PublicUser } from "../api";
import { setOfflineUserId } from "../offline/downloads";
import { flushProgressQueue } from "../offline/progress";
import { Shell } from "./Shell";
import { useRoute, navigate } from "../router";
import { InstallPage } from "../pages/InstallPage";
import { LoginPage } from "../pages/LoginPage";
import { InvitePage } from "../pages/InvitePage";
import { HomePage } from "../pages/HomePage";
import { ProfilePage } from "../pages/ProfilePage";
import { AboutPage } from "../pages/AboutPage";
import { AudiobooksPage } from "../features/audiobooks/AudiobooksPage";
import { AudiobookBookPage } from "../features/audiobooks/BookDetailPage";
import { MyListPage } from "../features/audiobooks/MyListPage";
import { SharedWithMePage } from "../features/audiobooks/SharedWithMePage";
import { EbooksPage } from "../features/audiobooks/EbooksPage";
import { SharePage } from "../pages/SharePage";
import { PlayerPage } from "../features/audiobooks/PlayerPage";
import { PersonListPage } from "../features/audiobooks/PersonListPage";
import { PersonDetailPage } from "../features/audiobooks/PersonDetailPage";
import { SeriesListPage } from "../features/audiobooks/SeriesListPage";
import { SeriesDetailPage } from "../features/audiobooks/SeriesDetailPage";
import { CategoryListPage } from "../features/audiobooks/CategoryListPage";
import { CategoryDetailPage } from "../features/audiobooks/CategoryDetailPage";
import { TagDetailPage } from "../features/audiobooks/TagDetailPage";
import { ControlPanelPage } from "../features/control/ControlPanelPage";

interface SessionState {
  loading: boolean;
  requiresSetup: boolean;
  user: PublicUser | null;
}

export function App() {
  const route = useRoute();
  const [session, setSession] = useState<SessionState>({
    loading: true,
    requiresSetup: false,
    user: null
  });

  const refreshSession = useCallback(async () => {
    const setup = await api<{ requiresSetup: boolean }>("/api/setup/status");
    if (setup.requiresSetup) {
      setSession({ loading: false, requiresSetup: true, user: null });
      return;
    }

    const me = await api<{ user: PublicUser }>("/api/auth/me").catch(() => ({ user: null as unknown as PublicUser }));
    setSession({ loading: false, requiresSetup: false, user: me.user });
  }, []);

  useEffect(() => {
    refreshSession().catch(() => setSession({ loading: false, requiresSetup: false, user: null }));
  }, [refreshSession]);

  // Remember the user id for offline storage namespacing (downloads are keyed
  // per user; /api/auth/me can't be reached without a network).
  useEffect(() => {
    if (session.user) setOfflineUserId(session.user.id);
  }, [session.user]);

  // Push any playback positions saved while offline once we're signed in, and
  // again whenever connectivity returns.
  useEffect(() => {
    if (!session.user) return;
    void flushProgressQueue();
    const onOnline = () => { void flushProgressQueue(); };
    window.addEventListener("online", onOnline);
    return () => window.removeEventListener("online", onOnline);
  }, [session.user]);

  useEffect(() => {
    const preferred = session.user?.theme ?? "dark";
    const mediaQuery = window.matchMedia("(prefers-color-scheme: dark)");
    const applyTheme = () => {
      const theme = preferred === "system" ? (mediaQuery.matches ? "plain-dark" : "plain-light") : preferred;
      document.documentElement.dataset.theme = theme;
    };

    applyTheme();
    mediaQuery.addEventListener("change", applyTheme);
    return () => mediaQuery.removeEventListener("change", applyTheme);
  }, [session.user?.theme]);

  useEffect(() => {
    if (session.loading) {
      return;
    }

    if (session.requiresSetup && route.name !== "install") {
      navigate("/install");
      return;
    }

    if (!session.requiresSetup && route.name === "install") {
      navigate(session.user ? "/" : "/login");
      return;
    }

    if (!session.requiresSetup && !session.user && !["login", "invite", "share"].includes(route.name)) {
      navigate("/login");
      return;
    }

    if (session.user && ["control", "controlCategoryEditor"].includes(route.name) && session.user.role !== "admin") {
      navigate("/");
    }
  }, [route.name, session]);

  const logout = async () => {
    await api("/api/auth/logout", { method: "POST", body: "{}" }).catch(() => undefined);
    setSession((current) => ({ ...current, user: null }));
    navigate("/login");
  };

  if (session.loading) {
    return <Shell><p className="status">Loading isputnik.home...</p></Shell>;
  }

  if (route.name === "install") {
    return <InstallPage onSignedIn={refreshSession} />;
  }

  if (route.name === "invite") {
    return <InvitePage token={route.token} onSignedIn={refreshSession} />;
  }

  // Guest share — viewable without an account.
  if (route.name === "share") {
    return <SharePage token={route.token} />;
  }

  if (route.name === "login") {
    return <LoginPage onSignedIn={refreshSession} />;
  }

  if (!session.user) {
    return <Shell><p className="status">Preparing sign in...</p></Shell>;
  }

  if (route.name === "control") {
    return session.user.role === "admin"
      ? <ControlPanelPage section={route.section} user={session.user} logout={logout} />
      : <HomePage user={session.user} logout={logout} />;
  }

  if (route.name === "controlCategoryEditor") {
    return session.user.role === "admin"
      ? <ControlPanelPage section="categories" categoryId={route.categoryId} user={session.user} logout={logout} />
      : <HomePage user={session.user} logout={logout} />;
  }

  if (route.name === "profile") {
    return (
      <ProfilePage
        user={session.user}
        logout={logout}
        onUpdated={(user) => setSession((current) => ({ ...current, user }))}
      />
    );
  }

  if (route.name === "about") {
    return <AboutPage user={session.user} logout={logout} />;
  }

  if (route.name === "audiobooks") {
    return <AudiobooksPage user={session.user} logout={logout} />;
  }

  if (route.name === "audiobookSaved") {
    return <MyListPage user={session.user} logout={logout} />;
  }

  if (route.name === "audiobookSharedWithMe") {
    return <SharedWithMePage user={session.user} logout={logout} />;
  }

  if (route.name === "audiobookBook") {
    return <AudiobookBookPage id={route.id} user={session.user} logout={logout} />;
  }

  if (route.name === "audiobookPlayer") {
    return <PlayerPage id={route.id} />;
  }

  if (route.name === "ebooks") {
    return <EbooksPage user={session.user} logout={logout} />;
  }

  if (route.name === "ebookBook") {
    return <AudiobookBookPage id={route.id} user={session.user} logout={logout} active="ebooks" backTo="/ebooks" />;
  }

  if (route.name === "audiobookAuthors") {
    return <PersonListPage role="author" user={session.user} logout={logout} />;
  }

  if (route.name === "audiobookAuthorDetail") {
    return <PersonDetailPage personName={route.personName} role="author" user={session.user} logout={logout} />;
  }

  if (route.name === "audiobookNarrators") {
    return <PersonListPage role="narrator" user={session.user} logout={logout} />;
  }

  if (route.name === "audiobookNarratorDetail") {
    return <PersonDetailPage personName={route.personName} role="narrator" user={session.user} logout={logout} />;
  }

  if (route.name === "audiobookSeries") {
    return <SeriesListPage user={session.user} logout={logout} />;
  }

  if (route.name === "audiobookSeriesDetail") {
    return <SeriesDetailPage seriesId={route.seriesId} user={session.user} logout={logout} />;
  }

  if (route.name === "audiobookCategories") {
    return <CategoryListPage user={session.user} logout={logout} />;
  }

  if (route.name === "audiobookCategoryDetail") {
    return <CategoryDetailPage categoryKey={route.categoryKey} user={session.user} logout={logout} />;
  }

  if (route.name === "audiobookTagDetail") {
    return <TagDetailPage tagName={route.tagName} user={session.user} logout={logout} />;
  }

  return <HomePage user={session.user} logout={logout} />;
}
