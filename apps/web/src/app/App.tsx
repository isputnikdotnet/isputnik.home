import { useState, useCallback, useEffect, lazy, Suspense } from "react";
import { api, type PublicUser } from "../api";
import { cacheCurrentUser, clearCachedUser, getCachedUser } from "../offline/downloads";
import { flushProgressQueue } from "../offline/progress";
import { flushQuoteQueue } from "../offline/quotes";
import { flushBookmarkQueue } from "../offline/bookmarks";
import { clearPrivateRuntimeCaches } from "../pwa/cache";
import { Shell } from "./Shell";
import { useRoute, navigate } from "../router";

// Eager: the shell, the ways in, and the page you land on. Everything on the
// critical path from a cold open to a usable Home stays in the entry chunk —
// splitting these would only add a round trip to first paint.
import { InstallPage } from "../pages/InstallPage";
import { LoginPage } from "../pages/LoginPage";
import { InvitePage } from "../pages/InvitePage";
import { HomePage } from "../pages/HomePage";

// Lazy: every other route. Before this, one bundle carried the whole app — the
// login screen downloaded the control panel, the family tree, the gallery and
// the reader before it could draw a password field. Each route now arrives when
// it is first opened and is cached from then on.
const WelcomePage = lazy(() => import("../pages/WelcomePage").then((m) => ({ default: m.WelcomePage })));
const ProfilePage = lazy(() => import("../pages/ProfilePage").then((m) => ({ default: m.ProfilePage })));
const AboutPage = lazy(() => import("../pages/AboutPage").then((m) => ({ default: m.AboutPage })));
const HelpPage = lazy(() => import("../pages/HelpPage").then((m) => ({ default: m.HelpPage })));
const GuidePage = lazy(() => import("../pages/GuidePage").then((m) => ({ default: m.GuidePage })));
const SharePage = lazy(() => import("../pages/SharePage").then((m) => ({ default: m.SharePage })));
const AudiobooksPage = lazy(() => import("../features/audiobooks/AudiobooksPage").then((m) => ({ default: m.AudiobooksPage })));
const AudiobookBookPage = lazy(() => import("../features/audiobooks/BookDetailPage").then((m) => ({ default: m.AudiobookBookPage })));
const EbooksPage = lazy(() => import("../features/audiobooks/EbooksPage").then((m) => ({ default: m.EbooksPage })));
const PlayerPage = lazy(() => import("../features/audiobooks/PlayerPage").then((m) => ({ default: m.PlayerPage })));
const NarratorListPage = lazy(() => import("../features/audiobooks/NarratorListPage").then((m) => ({ default: m.NarratorListPage })));
const PersonPage = lazy(() => import("../features/audiobooks/PersonPage").then((m) => ({ default: m.PersonPage })));
const AuthorListPage = lazy(() => import("../features/audiobooks/AuthorListPage").then((m) => ({ default: m.AuthorListPage })));
const SeriesListPage = lazy(() => import("../features/audiobooks/SeriesListPage").then((m) => ({ default: m.SeriesListPage })));
const SeriesDetailPage = lazy(() => import("../features/audiobooks/SeriesDetailPage").then((m) => ({ default: m.SeriesDetailPage })));
const CategoryListPage = lazy(() => import("../features/audiobooks/CategoryListPage").then((m) => ({ default: m.CategoryListPage })));
const CategoryDetailPage = lazy(() => import("../features/audiobooks/CategoryDetailPage").then((m) => ({ default: m.CategoryDetailPage })));
const TagListPage = lazy(() => import("../features/audiobooks/TagListPage").then((m) => ({ default: m.TagListPage })));
const TagDetailPage = lazy(() => import("../features/audiobooks/TagDetailPage").then((m) => ({ default: m.TagDetailPage })));
const MyListPage = lazy(() => import("../features/library/MyListPage").then((m) => ({ default: m.MyListPage })));
const BookmarksPage = lazy(() => import("../features/library/BookmarksPage").then((m) => ({ default: m.BookmarksPage })));
const QuotesPage = lazy(() => import("../features/library/QuotesPage").then((m) => ({ default: m.QuotesPage })));
const DownloadsPage = lazy(() => import("../features/library/DownloadsPage").then((m) => ({ default: m.DownloadsPage })));
const SharedWithMePage = lazy(() => import("../features/library/SharedWithMePage").then((m) => ({ default: m.SharedWithMePage })));
const LibraryFeedPage = lazy(() => import("../features/library/LibraryFeedPage").then((m) => ({ default: m.LibraryFeedPage })));
const CollectionsPage = lazy(() => import("../features/collections/CollectionsPage").then((m) => ({ default: m.CollectionsPage })));
const CollectionDetailPage = lazy(() => import("../features/collections/CollectionDetailPage").then((m) => ({ default: m.CollectionDetailPage })));
const GalleryPage = lazy(() => import("../features/gallery/GalleryPage").then((m) => ({ default: m.GalleryPage })));
const FamilyTreePage = lazy(() => import("../features/familytree/FamilyTreePage").then((m) => ({ default: m.FamilyTreePage })));
const FamilyPeoplePage = lazy(() => import("../features/familytree/FamilyPeoplePage").then((m) => ({ default: m.FamilyPeoplePage })));
const FamilyFamiliesPage = lazy(() => import("../features/familytree/FamilyFamiliesPage").then((m) => ({ default: m.FamilyFamiliesPage })));
const FamilyPersonPage = lazy(() => import("../features/familytree/FamilyPersonPage").then((m) => ({ default: m.FamilyPersonPage })));
const FamilyPersonPhotosPage = lazy(() => import("../features/familytree/FamilyPersonPhotosPage").then((m) => ({ default: m.FamilyPersonPhotosPage })));
const ControlPanelPage = lazy(() => import("../features/control/ControlPanelPage").then((m) => ({ default: m.ControlPanelPage })));

type Theme = PublicUser["theme"];

const DEFAULT_THEME_KEY = "isputnik-default-theme";

function cachedDefaultTheme(): Theme {
  try { return (localStorage.getItem(DEFAULT_THEME_KEY) as Theme | null) ?? "dark"; } catch { return "dark"; }
}

interface SessionState {
  loading: boolean;
  requiresSetup: boolean;
  /** First admin, guide not yet offered. See core/setup.ts. */
  onboardingPending: boolean;
  user: PublicUser | null;
  defaultTheme: Theme;
}

type SessionCheck =
  | { reachable: false }
  | { reachable: true; requiresSetup: boolean; user: PublicUser | null; defaultTheme: Theme; onboardingPending?: boolean };

// Probe the server with a hard timeout so a dead/slow network can never hang the
// app. Distinguishes "unreachable" (offline — keep the cached identity) from
// "reachable but 401" (really signed out — show login).
async function checkSession(): Promise<SessionCheck> {
  const controller = new AbortController();
  const timer = window.setTimeout(() => controller.abort(), 4000);
  try {
    const setupRes = await fetch("/api/setup/status", { credentials: "include", signal: controller.signal });
    if (!setupRes.ok) return { reachable: false };
    const setup = (await setupRes.json()) as { requiresSetup: boolean; defaultTheme?: Theme };
    const defaultTheme = setup.defaultTheme ?? "dark";
    if (setup.requiresSetup) return { reachable: true, requiresSetup: true, user: null, defaultTheme };

    const meRes = await fetch("/api/auth/me", { credentials: "include", signal: controller.signal });
    if (meRes.status === 401) return { reachable: true, requiresSetup: false, user: null, defaultTheme };
    if (!meRes.ok) return { reachable: false };
    const me = (await meRes.json()) as { user: PublicUser | null; onboardingPending?: boolean };
    return { reachable: true, requiresSetup: false, user: me.user ?? null, defaultTheme, onboardingPending: me.onboardingPending };
  } catch {
    return { reachable: false }; // network error or timeout/abort
  } finally {
    window.clearTimeout(timer);
  }
}

export function App() {
  const route = useRoute();
  const [session, setSession] = useState<SessionState>({
    loading: true,
    requiresSetup: false,
    onboardingPending: false,
    user: null,
    defaultTheme: cachedDefaultTheme()
  });

  const refreshSession = useCallback(async () => {
    const cached = getCachedUser();
    // Optimistic: if we know who you are, render the app immediately and never
    // block on the network — this is what keeps the installed app usable offline.
    if (cached) {
      setSession((s) => ({ ...s, loading: false, requiresSetup: false, user: cached }));
    }

    const result = await checkSession();
    if (!result.reachable) {
      // Offline / server unreachable — keep the cached identity; only fall to the
      // login screen if there's nothing cached (first-ever use on this device).
      if (!cached) setSession((s) => ({ ...s, loading: false, requiresSetup: false, user: null }));
      return;
    }
    try { localStorage.setItem(DEFAULT_THEME_KEY, result.defaultTheme); } catch { /* private mode */ }
    if (result.requiresSetup) {
      await clearPrivateRuntimeCaches().catch(() => {});
      clearCachedUser();
      setSession((s) => ({ ...s, loading: false, requiresSetup: true, user: null, defaultTheme: result.defaultTheme }));
      return;
    }
    if (result.user) {
      if (cached && cached.id !== result.user.id) {
        await clearPrivateRuntimeCaches().catch(() => {});
      }
      cacheCurrentUser(result.user);
      setSession((s) => ({ ...s, loading: false, requiresSetup: false, user: result.user, defaultTheme: result.defaultTheme, onboardingPending: Boolean(result.onboardingPending) }));
    } else {
      // Server reachable but not authenticated — a genuine sign-out / expiry.
      await clearPrivateRuntimeCaches().catch(() => {});
      clearCachedUser();
      setSession((s) => ({ ...s, loading: false, requiresSetup: false, user: null, defaultTheme: result.defaultTheme }));
    }
  }, []);

  useEffect(() => {
    refreshSession().catch(() => setSession((s) => ({ ...s, loading: false, requiresSetup: false, user: null })));
  }, [refreshSession]);

  // Keep the cached identity fresh (used for per-user storage namespacing and for
  // authenticating offline when /api/auth/me can't be reached).
  useEffect(() => {
    if (session.user) cacheCurrentUser(session.user);
  }, [session.user]);

  // Push anything saved while offline — playback positions, quotes, and bookmarks —
  // once we're signed in, and again whenever connectivity returns.
  useEffect(() => {
    if (!session.user) return;
    const flush = () => { void flushProgressQueue(); void flushQuoteQueue(); void flushBookmarkQueue(); };
    flush();
    window.addEventListener("online", flush);
    return () => window.removeEventListener("online", flush);
  }, [session.user]);

  useEffect(() => {
    // Signed-in users use their own theme; the sign-in screen and anyone without a
    // saved preference fall back to the admin-configured default theme.
    const preferred = session.user?.theme ?? session.defaultTheme;
    const mediaQuery = window.matchMedia("(prefers-color-scheme: dark)");
    const applyTheme = () => {
      const theme = preferred === "system" ? (mediaQuery.matches ? "plain-dark" : "plain-light") : preferred;
      document.documentElement.dataset.theme = theme;
    };

    applyTheme();
    mediaQuery.addEventListener("change", applyTheme);
    return () => mediaQuery.removeEventListener("change", applyTheme);
  }, [session.user?.theme, session.defaultTheme]);

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

    // The first administrator has never seen the setup guide. Send them there once —
    // from the landing page only, so a bookmark straight to a library still works and
    // a page they deliberately opened is never taken away from them.
    if (session.onboardingPending && route.name === "home") {
      navigate("/welcome");
      return;
    }

    if (session.user && ["control", "controlCategoryEditor"].includes(route.name) && session.user.role !== "admin") {
      navigate("/");
    }
  }, [route.name, session]);

  const logout = async () => {
    await api("/api/auth/logout", { method: "POST", body: "{}" }).catch(() => undefined);
    await clearPrivateRuntimeCaches().catch(() => undefined);
    clearCachedUser();
    setSession((current) => ({ ...current, user: null }));
    navigate("/login");
  };

  if (session.loading) {
    return <Shell><p className="status">Loading isputnik.home...</p></Shell>;
  }

  // Every route below the entry chunk is lazy, so one boundary sits above the
  // whole table rather than one per branch. The fallback is the same Shell line
  // the session check uses above, so a chunk fetch looks like the app still
  // starting up rather than a blank frame.
  return (
    <Suspense fallback={<Shell><p className="status">Loading isputnik.home...</p></Shell>}>
      {page()}
    </Suspense>
  );

  // Hoisted so the boundary above reads first; the route table is unchanged and
  // closes over the session state and handlers declared earlier in App().
  function page() {
    if (route.name === "welcome") {
      return session.user
        ? (
          <WelcomePage
            user={session.user}
            // Clear the flag HERE, in the state the redirect reads, before leaving —
            // otherwise Home sends us straight back to the guide we just closed.
            onDone={() => {
              setSession((current) => ({ ...current, onboardingPending: false }));
              navigate("/");
            }}
          />
        )
        : <Shell><p className="status">Preparing sign in...</p></Shell>;
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
          tab={route.tab}
          user={session.user}
          logout={logout}
          onUpdated={(user) => setSession((current) => ({ ...current, user }))}
        />
      );
    }

    if (route.name === "about") {
      return <AboutPage user={session.user} logout={logout} />;
    }

    if (route.name === "help") {
      return <HelpPage user={session.user} logout={logout} />;
    }

    if (route.name === "guide") {
      return <GuidePage slug={route.slug} user={session.user} logout={logout} />;
    }

    if (route.name === "audiobooks") {
      return <AudiobooksPage user={session.user} logout={logout} />;
    }

    if (route.name === "favorites") {
      return <MyListPage user={session.user} logout={logout} />;
    }

    if (route.name === "bookmarks") {
      return <BookmarksPage user={session.user} logout={logout} />;
    }

    if (route.name === "quotes") {
      return <QuotesPage user={session.user} logout={logout} />;
    }

    if (route.name === "downloads") {
      return <DownloadsPage user={session.user} logout={logout} />;
    }

    if (route.name === "sharedWithMe") {
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

    if (route.name === "gallery") {
      return <GalleryPage user={session.user} logout={logout} />;
    }

    if (route.name === "galleryMemories") {
      return <GalleryPage user={session.user} logout={logout} initialView="memories" />;
    }

    if (route.name === "galleryAsset") {
      return <GalleryPage user={session.user} logout={logout} initialAssetId={route.id} />;
    }

    if (route.name === "galleryFolder") {
      return (
        <GalleryPage
          user={session.user}
          logout={logout}
          initialFolder={route.folder}
          initialLibraryId={route.libraryId}
        />
      );
    }

    // Family tree — everyone signed in can view; edit affordances appear only for
    // admins inside the pages (the server enforces regardless).
    if (route.name === "familyTree") {
      return <FamilyTreePage user={session.user} logout={logout} focusId={route.focusId ?? null} />;
    }

    if (route.name === "familyPeople") {
      return <FamilyPeoplePage user={session.user} logout={logout} />;
    }

    if (route.name === "familyFamilies") {
      return <FamilyFamiliesPage user={session.user} logout={logout} />;
    }

    if (route.name === "familyPerson") {
      return <FamilyPersonPage id={route.id} user={session.user} logout={logout} />;
    }

    if (route.name === "familyPersonPhotos") {
      return <FamilyPersonPhotosPage id={route.id} user={session.user} logout={logout} />;
    }

    if (route.name === "libraryFeed") {
      return <LibraryFeedPage mode={route.mode} user={session.user} logout={logout} />;
    }

    if (route.name === "collections") {
      return <CollectionsPage user={session.user} logout={logout} />;
    }

    if (route.name === "collectionDetail") {
      return <CollectionDetailPage id={route.id} user={session.user} logout={logout} />;
    }

    if (route.name === "ebookBook") {
      return <AudiobookBookPage id={route.id} user={session.user} logout={logout} active="ebooks" backTo="/ebooks" />;
    }

    if (route.name === "authors") {
      return <AuthorListPage user={session.user} logout={logout} />;
    }

    if (route.name === "ebookAuthorDetail") {
      return <PersonPage personName={route.personName} user={session.user} logout={logout} />;
    }

    if (route.name === "ebookSeries") {
      return <SeriesListPage kind="ebook" user={session.user} logout={logout} />;
    }

    if (route.name === "ebookSeriesDetail") {
      return <SeriesDetailPage seriesId={route.seriesId} kind="ebook" user={session.user} logout={logout} />;
    }

    if (route.name === "personDetail" || route.name === "audiobookAuthorDetail") {
      return <PersonPage personName={route.personName} user={session.user} logout={logout} />;
    }

    if (route.name === "audiobookNarrators") {
      return <NarratorListPage user={session.user} logout={logout} />;
    }

    if (route.name === "audiobookNarratorDetail") {
      return <PersonPage personName={route.personName} user={session.user} logout={logout} />;
    }

    if (route.name === "audiobookSeries") {
      return <SeriesListPage user={session.user} logout={logout} />;
    }

    if (route.name === "audiobookSeriesDetail") {
      return <SeriesDetailPage seriesId={route.seriesId} user={session.user} logout={logout} />;
    }

    if (route.name === "categories") {
      return <CategoryListPage user={session.user} logout={logout} />;
    }

    if (route.name === "categoryDetail") {
      return <CategoryDetailPage categoryKey={route.categoryKey} user={session.user} logout={logout} />;
    }

    if (route.name === "tags") {
      return <TagListPage user={session.user} logout={logout} />;
    }

    if (route.name === "tagDetail") {
      return <TagDetailPage tagName={route.tagName} user={session.user} logout={logout} />;
    }

    return <HomePage user={session.user} logout={logout} />;
  }
}
