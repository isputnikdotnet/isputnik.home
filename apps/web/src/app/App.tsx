import { useState, useCallback, useEffect, useMemo, lazy, Suspense } from "react";
import { useTranslation } from "react-i18next";
import { api, isAdminSession, type PublicUser } from "../api";
import { setAppLanguage } from "../i18n";
import { cacheCurrentUser, clearCachedUser, getCachedUser } from "../offline/downloads";
import { flushProgressQueue } from "../offline/progress";
import { flushQuoteQueue } from "../offline/quotes";
import { flushBookmarkQueue } from "../offline/bookmarks";
import { clearPrivateRuntimeCaches } from "../pwa/cache";
import { AppLoading, Shell } from "./Shell";
import { SessionContext, type Session } from "./SessionContext";
import { LoadErrorBoundary } from "../shared/LoadErrorBoundary";
import { useRoute, navigate, rememberPathAfterSignIn } from "../router";

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
const DropPage = lazy(() => import("../pages/DropPage").then((m) => ({ default: m.DropPage })));
const DeviceLinkPage = lazy(() => import("../pages/DeviceLinkPage").then((m) => ({ default: m.DeviceLinkPage })));
const DeviceLinkConfirmPage = lazy(() => import("../pages/DeviceLinkConfirmPage").then((m) => ({ default: m.DeviceLinkConfirmPage })));
// The Audiobooks and Ebooks pages — one component, drawn for either kind.
const CatalogPage = lazy(() => import("../features/audiobooks/catalog/CatalogPage").then((m) => ({ default: m.CatalogPage })));
const AudiobookBookPage = lazy(() => import("../features/audiobooks/BookDetailPage").then((m) => ({ default: m.AudiobookBookPage })));
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
const LikesPage = lazy(() => import("../features/library/LikesPage").then((m) => ({ default: m.LikesPage })));
const BookmarksPage = lazy(() => import("../features/library/BookmarksPage").then((m) => ({ default: m.BookmarksPage })));
const QuotesPage = lazy(() => import("../features/library/QuotesPage").then((m) => ({ default: m.QuotesPage })));
const DownloadsPage = lazy(() => import("../features/library/DownloadsPage").then((m) => ({ default: m.DownloadsPage })));
const ForYouPage = lazy(() => import("../features/social/ForYouPage").then((m) => ({ default: m.ForYouPage })));
const LibraryFeedPage = lazy(() => import("../features/library/LibraryFeedPage").then((m) => ({ default: m.LibraryFeedPage })));
const CollectionsPage = lazy(() => import("../features/collections/CollectionsPage").then((m) => ({ default: m.CollectionsPage })));
const CollectionDetailPage = lazy(() => import("../features/collections/CollectionDetailPage").then((m) => ({ default: m.CollectionDetailPage })));
const StoriesPage = lazy(() => import("../features/stories/StoriesPage").then((m) => ({ default: m.StoriesPage })));
const StoryDetailPage = lazy(() => import("../features/stories/StoryDetailPage").then((m) => ({ default: m.StoryDetailPage })));
const StoryCollectionPage = lazy(() => import("../features/stories/StoryCollectionPage").then((m) => ({ default: m.StoryCollectionPage })));
const StoryEditorPage = lazy(() => import("../features/stories/StoryEditorPage").then((m) => ({ default: m.StoryEditorPage })));
const GalleryPage = lazy(() => import("../features/gallery/GalleryPage").then((m) => ({ default: m.GalleryPage })));
const PhotoInboxPage = lazy(() => import("../features/gallery/PhotoInboxPage").then((m) => ({ default: m.PhotoInboxPage })));
const ReviewPage = lazy(() => import("../features/gallery/review/ReviewPage").then((m) => ({ default: m.ReviewPage })));
const FamilyTreePage = lazy(() => import("../features/familytree/FamilyTreePage").then((m) => ({ default: m.FamilyTreePage })));
const FamilyPeoplePage = lazy(() => import("../features/familytree/FamilyPeoplePage").then((m) => ({ default: m.FamilyPeoplePage })));
const FamilyFamiliesPage = lazy(() => import("../features/familytree/FamilyFamiliesPage").then((m) => ({ default: m.FamilyFamiliesPage })));
const FamilyPersonPage = lazy(() => import("../features/familytree/FamilyPersonPage").then((m) => ({ default: m.FamilyPersonPage })));
const FamilyPersonPhotosPage = lazy(() => import("../features/familytree/FamilyPersonPhotosPage").then((m) => ({ default: m.FamilyPersonPhotosPage })));
const ControlPanelPage = lazy(() => import("../features/control/ControlPanelPage").then((m) => ({ default: m.ControlPanelPage })));

type Theme = PublicUser["theme"];

const DEFAULT_THEME_KEY = "isputnik-default-theme";

function cachedDefaultTheme(): Theme {
  try { return (localStorage.getItem(DEFAULT_THEME_KEY) as Theme | null) ?? "minimalist"; } catch { return "minimalist"; }
}

interface SessionState {
  loading: boolean;
  requiresSetup: boolean;
  /** First admin, guide not yet offered. See core/setup.ts. */
  onboardingPending: boolean;
  user: PublicUser | null;
  defaultTheme: Theme;
  /** Whether this install can offer passkeys at all — false on a plain-http LAN
   *  deployment, where the browser has no WebAuthn to call. See core/webauthn.ts. */
  passkeysAvailable: boolean;
  /** Whether a device may be linked from THIS address right now: true at home, and
   *  outside only while an admin has opened a registration window. The sign-in
   *  screen leaves the option out entirely when it is false, rather than offering a
   *  button that answers 403. See core/device-link.ts. */
  deviceLinkAvailable: boolean;
}

type SessionCheck =
  | { reachable: false }
  | {
      reachable: true;
      requiresSetup: boolean;
      user: PublicUser | null;
      defaultTheme: Theme;
      passkeysAvailable: boolean;
      deviceLinkAvailable: boolean;
      onboardingPending?: boolean;
    };

// Probe the server with a hard timeout so a dead/slow network can never hang the
// app. Distinguishes "unreachable" (offline — keep the cached identity) from
// "reachable but 401" (really signed out — show login).
async function checkSession(): Promise<SessionCheck> {
  const controller = new AbortController();
  const timer = window.setTimeout(() => controller.abort(), 4000);
  try {
    const setupRes = await fetch("/api/setup/status", { credentials: "include", signal: controller.signal });
    if (!setupRes.ok) return { reachable: false };
    const setup = (await setupRes.json()) as {
      requiresSetup: boolean;
      defaultTheme?: Theme;
      passkeysAvailable?: boolean;
      deviceLinkAvailable?: boolean;
    };
    const defaultTheme = setup.defaultTheme ?? "minimalist";
    const passkeysAvailable = Boolean(setup.passkeysAvailable);
    const deviceLinkAvailable = Boolean(setup.deviceLinkAvailable);
    if (setup.requiresSetup) return { reachable: true, requiresSetup: true, user: null, defaultTheme, passkeysAvailable, deviceLinkAvailable };

    const meRes = await fetch("/api/auth/me", { credentials: "include", signal: controller.signal });
    if (meRes.status === 401) return { reachable: true, requiresSetup: false, user: null, defaultTheme, passkeysAvailable, deviceLinkAvailable };
    if (!meRes.ok) return { reachable: false };
    const me = (await meRes.json()) as { user: PublicUser | null; onboardingPending?: boolean };
    return {
      reachable: true,
      requiresSetup: false,
      user: me.user ?? null,
      defaultTheme,
      passkeysAvailable,
      deviceLinkAvailable,
      onboardingPending: me.onboardingPending
    };
  } catch {
    return { reachable: false }; // network error or timeout/abort
  } finally {
    window.clearTimeout(timer);
  }
}

export function App() {
  const route = useRoute();
  const { t } = useTranslation();
  // Seeded from the cached identity rather than starting blank, so a reload
  // paints the app on its first frame. Starting at loading:true meant every
  // refresh showed the sign-in scene until the effect below ran — one frame, but
  // an alarming one, and it also flashed the wrong theme on the way past.
  // refreshSession still runs and still falls to the login screen if the server
  // says the session is gone; this only decides what is on screen until it answers.
  const [session, setSession] = useState<SessionState>(() => {
    const cached = getCachedUser();
    return {
      loading: !cached,
      requiresSetup: false,
      onboardingPending: false,
      user: cached,
      defaultTheme: cachedDefaultTheme(),
      // Not cached: it is cheap to learn and wrong to guess. Until the server
      // answers the sign-in screen simply doesn't offer the passkey button.
      passkeysAvailable: false,
      deviceLinkAvailable: false
    };
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
      setSession((s) => ({ ...s, loading: false, requiresSetup: true, user: null, defaultTheme: result.defaultTheme, passkeysAvailable: result.passkeysAvailable, deviceLinkAvailable: result.deviceLinkAvailable }));
      return;
    }
    if (result.user) {
      if (cached && cached.id !== result.user.id) {
        await clearPrivateRuntimeCaches().catch(() => {});
      }
      cacheCurrentUser(result.user);
      setSession((s) => ({ ...s, loading: false, requiresSetup: false, user: result.user, defaultTheme: result.defaultTheme, passkeysAvailable: result.passkeysAvailable, deviceLinkAvailable: result.deviceLinkAvailable, onboardingPending: Boolean(result.onboardingPending) }));
    } else {
      // Server reachable but not authenticated — a genuine sign-out / expiry.
      await clearPrivateRuntimeCaches().catch(() => {});
      clearCachedUser();
      setSession((s) => ({ ...s, loading: false, requiresSetup: false, user: null, defaultTheme: result.defaultTheme, passkeysAvailable: result.passkeysAvailable, deviceLinkAvailable: result.deviceLinkAvailable }));
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

  // Keep the interface language in step with the signed-in user's preference
  // (setAppLanguage also persists it, so the next boot — and the sign-in screen
  // after a sign-out — starts in the right language). Signed out, whatever
  // storedLanguage() booted stays as-is.
  useEffect(() => {
    const language = session.user?.language;
    if (language) void setAppLanguage(language);
  }, [session.user?.language]);

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

    // deviceLink is here for the same reason login is: the display asking to be
    // linked has nobody to be signed in as yet, and sending it to /login is
    // sending it back to the keyboard it hasn't got.
    if (!session.requiresSetup && !session.user && !["login", "invite", "share", "drop", "deviceLink"].includes(route.name)) {
      // Scanning the QR on a phone that isn't signed in lands here. Remember the
      // errand before sending them to sign in, or approving a device turns into
      // "sign in, arrive at the home page, wonder what happened to the code".
      if (route.name === "deviceLinkConfirm") {
        rememberPathAfterSignIn(`${window.location.pathname}${window.location.search}`);
      }
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

    // Not just "are they an admin" — a linked display is refused on every admin
    // route, so letting it open the control panel yields a page of 403s.
    if (session.user && ["control", "controlCategoryEditor"].includes(route.name) && !isAdminSession(session.user)) {
      navigate("/");
    }
  }, [route.name, session]);

  const logout = useCallback(async () => {
    await api("/api/auth/logout", { method: "POST", body: "{}" }).catch(() => undefined);
    await clearPrivateRuntimeCaches().catch(() => undefined);
    clearCachedUser();
    setSession((current) => ({ ...current, user: null }));
    navigate("/login");
  }, []);

  // What every signed-in page reads through useSession() — null behind the
  // sign-in gate, where no page that asks for it is ever drawn.
  const signedIn = useMemo<Session | null>(
    () => (session.user ? { user: session.user, logout, isAdminSession: isAdminSession(session.user) } : null),
    [session.user, logout]
  );

  if (session.loading) {
    return <Shell><p className="status">{t("app.loading")}</p></Shell>;
  }

  // Every route below the entry chunk is lazy, so one boundary sits above the
  // whole table rather than one per branch. Navigation itself no longer reaches
  // this fallback — useRoute switches routes in a transition, which holds the
  // current page on screen until the next one's chunk lands. What is left is the
  // cold open straight into a lazy route, and there the screen depends on who is
  // waiting: someone signed in gets a bare surface, because the alternative is
  // being shown the sign-in scene by an app they are already signed in to.
  const loading = session.user
    ? <AppLoading><p className="status">{t("app.loading")}</p></AppLoading>
    : <Shell><p className="status">{t("app.loading")}</p></Shell>;

  // The service worker precaches only the shell and the offline screens (see
  // vite.config.ts), so offline, a page never opened on this device has no code
  // to load. The boundary turns that rejected import into a message with a way
  // home instead of a blank app; it resets on the next route.
  return (
    <SessionContext.Provider value={signedIn}>
      <LoadErrorBoundary resetKey={route} frame={(message) => <AppLoading>{message}</AppLoading>}>
        <Suspense fallback={loading}>{page()}</Suspense>
      </LoadErrorBoundary>
    </SessionContext.Provider>
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

    // Photo Inbox drop link — an upload without an account.
    if (route.name === "drop") {
      return <DropPage token={route.token} />;
    }

    if (route.name === "login") {
      return (
        <LoginPage
          onSignedIn={refreshSession}
          passkeysAvailable={session.passkeysAvailable}
          deviceLinkAvailable={session.deviceLinkAvailable}
        />
      );
    }

    // Reachable signed in as well as out: someone can open /link on a display that
    // still holds an old session, and the flow works the same either way.
    if (route.name === "deviceLink") {
      return <DeviceLinkPage onSignedIn={refreshSession} />;
    }

    if (!session.user) {
      return <Shell><p className="status">Preparing sign in...</p></Shell>;
    }

    // Below the signed-out gate: approving needs an account, and an anonymous
    // visitor has already been sent to sign in with this path remembered.
    if (route.name === "deviceLinkConfirm") {
      return <DeviceLinkConfirmPage userCode={route.userCode} />;
    }

    if (route.name === "control") {
      return isAdminSession(session.user)
        ? <ControlPanelPage section={route.section} />
        : <HomePage />;
    }

    if (route.name === "controlCategoryEditor") {
      return isAdminSession(session.user)
        ? <ControlPanelPage section="categories" categoryId={route.categoryId} />
        : <HomePage />;
    }

    if (route.name === "profile") {
      return (
        <ProfilePage
          tab={route.tab}
          onUpdated={(user) => setSession((current) => ({ ...current, user }))}
        />
      );
    }

    if (route.name === "about") {
      return <AboutPage />;
    }

    if (route.name === "help") {
      return <HelpPage />;
    }

    if (route.name === "guide") {
      return <GuidePage slug={route.slug} />;
    }

    if (route.name === "audiobooks") {
      // Keyed by kind so moving between the two catalogs mounts a fresh page
      // rather than carrying one kind's libraries and selection into the other.
      return <CatalogPage key="audiobook" kind="audiobook" />;
    }

    if (route.name === "likes") {
      return <LikesPage />;
    }

    if (route.name === "bookmarks") {
      return <BookmarksPage />;
    }

    if (route.name === "quotes") {
      return <QuotesPage />;
    }

    if (route.name === "downloads") {
      return <DownloadsPage />;
    }

    if (route.name === "forYou") {
      return <ForYouPage />;
    }

    if (route.name === "audiobookBook") {
      return <AudiobookBookPage id={route.id} />;
    }

    if (route.name === "audiobookPlayer") {
      return <PlayerPage id={route.id} />;
    }

    if (route.name === "ebooks") {
      return <CatalogPage key="ebook" kind="ebook" />;
    }

    if (route.name === "gallery") {
      return <GalleryPage view={route.view} />;
    }

    if (route.name === "galleryAsset") {
      return <GalleryPage view="timeline" initialAssetId={route.id} />;
    }

    if (route.name === "galleryAlbum") {
      return <GalleryPage view="albums" initialAlbumId={route.id} />;
    }

    if (route.name === "gallerySlideshow") {
      return <GalleryPage view="slideshows" initialSlideshowId={route.id} />;
    }

    if (route.name === "galleryInbox") {
      return <PhotoInboxPage libraryId={route.libraryId} />;
    }

    if (route.name === "galleryReview") {
      // Chrome-free, like the story reading view: one photo, four questions.
      return <ReviewPage source={{ kind: "inbox", libraryId: route.libraryId, folder: route.folder }} />;
    }

    if (route.name === "galleryReviewAlbum") {
      return <ReviewPage source={{ kind: "album", albumId: route.albumId, recommendationId: route.recommendationId }} />;
    }

    if (route.name === "galleryFolder") {
      return (
        <GalleryPage
          view="folder"
          initialFolder={route.folder}
          initialLibraryId={route.libraryId}
        />
      );
    }

    // Family tree — everyone signed in can view; edit affordances appear only for
    // admins inside the pages (the server enforces regardless).
    if (route.name === "familyTree") {
      return <FamilyTreePage focusId={route.focusId ?? null} />;
    }

    if (route.name === "familyPeople") {
      return <FamilyPeoplePage />;
    }

    if (route.name === "familyFamilies") {
      return <FamilyFamiliesPage />;
    }

    if (route.name === "familyPerson") {
      return <FamilyPersonPage id={route.id} />;
    }

    if (route.name === "familyPersonPhotos") {
      return <FamilyPersonPhotosPage id={route.id} />;
    }

    if (route.name === "libraryFeed") {
      return <LibraryFeedPage mode={route.mode} />;
    }

    if (route.name === "collections") {
      return <CollectionsPage />;
    }

    if (route.name === "collectionDetail") {
      return <CollectionDetailPage id={route.id} />;
    }

    if (route.name === "stories") {
      return <StoriesPage />;
    }

    if (route.name === "storyDetail") {
      // Chrome-free story site view (like the audiobook player page) — no shell.
      return <StoryDetailPage id={route.id} />;
    }

    if (route.name === "storyChapter") {
      return <StoryDetailPage id={route.id} chapterId={route.chapterId} />;
    }

    if (route.name === "storyCollection") {
      return <StoryCollectionPage id={route.id} />;
    }

    if (route.name === "storyEditor") {
      return (
        <StoryEditorPage
          id={route.id}
          pane={route.pane}
          chapterId={route.chapterId}
        />
      );
    }

    if (route.name === "ebookBook") {
      return <AudiobookBookPage id={route.id} active="ebooks" backTo="/ebooks" />;
    }

    if (route.name === "authors") {
      return <AuthorListPage />;
    }

    if (route.name === "ebookAuthorDetail") {
      return <PersonPage personName={route.personName} />;
    }

    if (route.name === "ebookSeries") {
      return <SeriesListPage kind="ebook" />;
    }

    if (route.name === "ebookSeriesDetail") {
      return <SeriesDetailPage seriesId={route.seriesId} kind="ebook" />;
    }

    if (route.name === "personDetail" || route.name === "audiobookAuthorDetail") {
      return <PersonPage personName={route.personName} />;
    }

    if (route.name === "audiobookNarrators") {
      return <NarratorListPage />;
    }

    if (route.name === "audiobookNarratorDetail") {
      return <PersonPage personName={route.personName} />;
    }

    if (route.name === "audiobookSeries") {
      return <SeriesListPage />;
    }

    if (route.name === "audiobookSeriesDetail") {
      return <SeriesDetailPage seriesId={route.seriesId} />;
    }

    if (route.name === "categories") {
      return <CategoryListPage />;
    }

    if (route.name === "categoryDetail") {
      return <CategoryDetailPage categoryKey={route.categoryKey} />;
    }

    if (route.name === "tags") {
      return <TagListPage />;
    }

    if (route.name === "tagDetail") {
      return <TagDetailPage tagName={route.tagName} />;
    }

    return <HomePage />;
  }
}
