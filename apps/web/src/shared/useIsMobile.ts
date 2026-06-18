import { useEffect, useState } from "react";

// True when the viewport is at or below the app's mobile breakpoint — the same
// 740px the CSS uses to switch to the bottom-nav app layout. Drives mobile-only
// rendering (e.g. the Home feed's list rows) so the desktop tree stays untouched.
const MOBILE_QUERY = "(max-width: 740px)";

export function useIsMobile(): boolean {
  const [isMobile, setIsMobile] = useState(
    () => typeof window !== "undefined" && window.matchMedia(MOBILE_QUERY).matches
  );

  useEffect(() => {
    const mq = window.matchMedia(MOBILE_QUERY);
    const onChange = () => setIsMobile(mq.matches);
    onChange();
    mq.addEventListener("change", onChange);
    return () => mq.removeEventListener("change", onChange);
  }, []);

  return isMobile;
}
