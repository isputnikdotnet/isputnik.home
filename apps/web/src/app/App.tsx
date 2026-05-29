import { useState, useCallback, useEffect } from "react";
import { api, type PublicUser } from "../api";
import { Shell } from "./Shell";
import { useRoute, navigate } from "../router";
import { InstallPage } from "../pages/InstallPage";
import { LoginPage } from "../pages/LoginPage";
import { InvitePage } from "../pages/InvitePage";
import { HomePage } from "../pages/HomePage";
import { ProfilePage } from "../pages/ProfilePage";
import { AboutPage } from "../pages/AboutPage";
import { AudiobookBookPage, AudiobooksPage } from "../features/audiobooks/AudiobooksPage";
import { PersonListPage } from "../features/audiobooks/PersonListPage";
import { PersonDetailPage } from "../features/audiobooks/PersonDetailPage";
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

    if (!session.requiresSetup && !session.user && !["login", "invite"].includes(route.name)) {
      navigate("/login");
      return;
    }

    if (session.user && route.name === "control" && session.user.role !== "admin") {
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

  if (route.name === "audiobookBook") {
    return <AudiobookBookPage id={route.id} user={session.user} logout={logout} />;
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

  return <HomePage user={session.user} logout={logout} />;
}
