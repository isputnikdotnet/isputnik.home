import { Component, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { navigate } from "../router";
import { Button } from "./Button";
import { MessageBox } from "./MessageBox";

// What a failed dynamic import says, per engine: Chromium, Firefox, Safari, and
// Vite's preload helper when a chunk's CSS or dependency fails first.
const CHUNK_LOAD_ERROR = /dynamically imported module|Importing a module script failed|Unable to preload|ChunkLoadError/i;

export function isChunkLoadError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  return error.name === "ChunkLoadError" || CHUNK_LOAD_ERROR.test(error.message);
}

/** Catches a lazy page or section whose code could not be downloaded.
 *
 *  The service worker precaches the app shell and the offline screens only, so
 *  opening anything else with no network — or a page whose chunk a newer release
 *  has replaced — makes its `import()` reject. Without a boundary React unmounts
 *  the whole app and leaves a blank screen; this keeps the rest of it working and
 *  says what happened. Any OTHER error is rethrown untouched: a render bug should
 *  fail as loudly as it did before, not pass for a network problem.
 *
 *  A rejected `lazy()` stays rejected, so the way out is a reload, or moving on —
 *  change `resetKey` (the route) and the boundary tries again. */
export class LoadErrorBoundary extends Component<
  {
    children: ReactNode;
    /** Clears the error when it changes — pass the current route. */
    resetKey?: unknown;
    /** Wraps the message, for a boundary that stands in for a whole page. */
    frame?: (message: ReactNode) => ReactNode;
  },
  { error: unknown; resetKey: unknown }
> {
  state = { error: null as unknown, resetKey: this.props.resetKey };

  static getDerivedStateFromError(error: unknown) {
    return { error };
  }

  static getDerivedStateFromProps(props: { resetKey?: unknown }, state: { error: unknown; resetKey: unknown }) {
    return props.resetKey === state.resetKey ? null : { error: null, resetKey: props.resetKey };
  }

  render() {
    const { error } = this.state;
    if (error == null) return this.props.children;
    if (!isChunkLoadError(error)) throw error;
    const message = <PageLoadFailed />;
    return this.props.frame ? this.props.frame(message) : message;
  }
}

function PageLoadFailed() {
  const { t } = useTranslation();
  const offline = typeof navigator !== "undefined" && navigator.onLine === false;
  return (
    <MessageBox
      tone="warning"
      title={t("errors.pageLoad.title")}
      action={
        <>
          <Button variant="secondary" compact onClick={() => navigate("/")}>
            {t("errors.pageLoad.home")}
          </Button>
          <Button variant="primary" compact onClick={() => window.location.reload()}>
            {t("errors.pageLoad.reload")}
          </Button>
        </>
      }
    >
      {offline ? t("errors.pageLoad.offline") : t("errors.pageLoad.online")}
    </MessageBox>
  );
}
