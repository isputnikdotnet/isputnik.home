// Which layout this browser wears above the phone breakpoint: the top bar, or the
// classic sidebar for anyone who wants it back for now. Per browser rather than per
// account because the choice is temporary (docs/top-layout-plan.md): there is no
// column to migrate away when the classic layout goes.
export type LayoutChoice = "top" | "classic";

const KEY = "isputnik.layout";

function read(): LayoutChoice {
  try {
    return window.localStorage.getItem(KEY) === "classic" ? "classic" : "top";
  } catch {
    // Blocked site data: the default layout works without remembering anything.
    return "top";
  }
}

const current = read();

export function layoutChoice(): LayoutChoice {
  return current;
}

export function usesTopLayout(): boolean {
  return current === "top";
}

// The whole shell is built around the choice, so it takes effect on a fresh load.
export function chooseLayout(choice: LayoutChoice): void {
  if (choice === current) return;
  try {
    if (choice === "classic") window.localStorage.setItem(KEY, "classic");
    else window.localStorage.removeItem(KEY);
  } catch {
    return; // Nowhere to remember it, so a reload would change nothing.
  }
  window.location.reload();
}
