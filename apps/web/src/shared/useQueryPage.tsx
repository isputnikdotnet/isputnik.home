import { useCallback, useEffect, useState, type ReactNode } from "react";
import { ArrowLeft } from "lucide-react";

// A list page that opens small pages of its own — a job, a network, a backup —
// the way a phone's Settings does (control panel v2's grouped rows). Which one is
// open lives in the address (?show=…) so Back, reload and links all work; each
// step in is a history entry, so the browser's Back returns to the list.

function read(param: string): string | null {
  return new URLSearchParams(window.location.search).get(param);
}

export function useQueryPage(param = "show"): [string | null, (next: string | null) => void] {
  const [value, setValue] = useState<string | null>(() => read(param));
  useEffect(() => {
    const onPop = () => setValue(read(param));
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, [param]);
  const go = useCallback((next: string | null) => {
    const query = new URLSearchParams(window.location.search);
    if (next) query.set(param, next);
    else query.delete(param);
    window.history.pushState(window.history.state, "", `${window.location.pathname}${query.size ? `?${query}` : ""}`);
    setValue(next);
    window.scrollTo({ top: 0 });
  }, [param]);
  return [value, go];
}

/** "← <list>" above a page opened from a list. */
export function PageBack({ label, onBack }: { label: ReactNode; onBack: () => void }) {
  return (
    <a
      className="text-button control-page-back"
      href={window.location.pathname}
      onClick={(event) => { event.preventDefault(); onBack(); }}
    >
      <ArrowLeft size={15} aria-hidden="true" />
      {label}
    </a>
  );
}

/** The name of the thing a page opened from a list is about. */
export function PageTitle({ children, extra }: { children: ReactNode; extra?: ReactNode }) {
  return (
    <div className="device-sync-title">
      <h1>{children}</h1>
      {extra}
    </div>
  );
}
