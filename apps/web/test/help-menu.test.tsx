import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { Home } from "lucide-react";
import i18n from "../src/i18n";
import { OrbitTopBar } from "../src/app/OrbitTopBar";
import { helpMenuLinks } from "../src/app/helpMenu";
import { APP_VERSION } from "../src/shared/appVersion";

// Help & feedback: the ? beside the person's name in the top bar. Getting help,
// giving feedback (administrators only — those links lead to GitHub), and About.

const t = i18n.t.bind(i18n);

function bar(isAdmin: boolean) {
  render(
    <OrbitTopBar
      items={[{ label: "Home", href: "/", icon: Home, active: true }]}
      media={null}
      controlHref={isAdmin ? "/control" : null}
      displayName="Demo Admin"
      unseen={0}
      menuLinks={[{ label: "Profile", href: "/profile", icon: Home }]}
      helpLinks={helpMenuLinks(t, isAdmin)}
      onLogout={() => undefined}
    />
  );
}

describe("help & feedback", () => {
  it("gives an administrator the guides, the community, a bug report with the version filled in, a feature request and About", async () => {
    bar(true);
    await userEvent.click(screen.getByRole("button", { name: "Help & feedback" }));
    const menu = screen.getByRole("menu", { name: "Help & feedback" });
    const names = within(menu).getAllByRole("menuitem").map((item) => item.textContent);
    expect(names).toEqual(["Help guides", "Ask the community", "Report a bug", "Request a feature", "About iSputnik"]);

    const bug = within(menu).getByRole("menuitem", { name: "Report a bug" });
    expect(bug).toHaveAttribute("href", expect.stringContaining("template=bug_report.yml"));
    expect(bug).toHaveAttribute("href", expect.stringContaining(`version=${encodeURIComponent(APP_VERSION)}`));
    expect(bug).toHaveAttribute("target", "_blank");
    expect(within(menu).getByRole("menuitem", { name: "Ask the community" })).toHaveAttribute("href", expect.stringMatching(/\/discussions$/));
    expect(within(menu).getByRole("menuitem", { name: "Request a feature" })).toHaveAttribute("href", expect.stringContaining("template=feature_request.yml"));
    // Two rules: between help, feedback and About.
    expect(within(menu).getAllByRole("separator")).toHaveLength(2);
  });

  it("keeps a member to the guides and About: nothing that leads off to GitHub", async () => {
    bar(false);
    await userEvent.click(screen.getByRole("button", { name: "Help & feedback" }));
    const menu = screen.getByRole("menu", { name: "Help & feedback" });
    expect(within(menu).getAllByRole("menuitem").map((item) => item.textContent)).toEqual(["Help guides", "About iSputnik"]);
    expect(within(menu).queryByRole("menuitem", { name: "Report a bug" })).toBeNull();
  });

  it("leaves the name's menu to the person's own things", async () => {
    bar(true);
    await userEvent.click(screen.getByRole("button", { name: /Demo Admin/ }));
    const menu = screen.getByRole("menu", { name: "Profile menu" });
    expect(within(menu).queryByRole("menuitem", { name: /Help|Report a bug|About/ })).toBeNull();
    // Opening one menu closes the other.
    await userEvent.click(screen.getByRole("button", { name: "Help & feedback" }));
    expect(screen.queryByRole("menu", { name: "Profile menu" })).toBeNull();
  });
});
