# Control panel navigation review

Reviewed September 10, 2026, against app version 3.90.0.

> **Status (2026-09-16, in-code for 4.15):** steps 1 and 2 are implemented, with two
> deliberate departures. **Maps** went into Settings as a tab (it had become its own
> group in 4.4 and then shrank to one page of cards), so the panel has six groups as
> proposed. The proposal’s **fold-out group menu** that would replace the tab row was
> *not* adopted: every group keeps one row of its tabs, and labels were not renamed
> (Users, Storage stay). Step 3 is implemented too: typed links between pages
> (`features/control/links.ts`) with filters read from the address, and the phone
> menu. Not done from step 3: a Recycle Bin → Storage link, since the bin's location
> is already edited on the bin page itself. (A person dive on Sign-ins links to Logs
> filtered to that person since 4.15.1.)

The recommended direction is six groups with consistent navigation: Overview, Libraries & storage, Members, Security, Maintenance, and Settings. Remove Utilities by moving photo cleanup into Maintenance and Quotes into Settings. Bring the Dashboard's destinations into those groups, and put personal reader tokens under Profile.

This is a proposal. No application behavior has been changed. The review used the current navigation definitions, router, page components, search index, responsive CSS, user documentation, and the existing desktop Dashboard screenshot. It did not include a live browser walkthrough or user testing. Findings about behavior below are based on the implementation; recommendations about findability should be validated with representative tasks.

## What exists today

There are 27 registered control-panel pages across seven groups. Dashboard contains another navigation row with six addressable views.

| Group | Current pages |
| --- | --- |
| Overview | Dashboard, Logs. Dashboard views: Sign-ins, Locations, Activity, Libraries, Tasks, System |
| Library | Libraries, Storage, Storage contents, Categories, Tags |
| Members | Users, Groups, Invite links |
| Security | Overview, Policies, Trusted networks, Blocked IPs |
| Maintenance | Backup, Scheduled jobs, Recycle Bin |
| Utilities | Gallery branch: Duplicate cleanup, Missing photos. Widgets branch: Quotes |
| Settings | Appearance, Email, Notifications, Stories, Maps, Reader access, About |

The foundation is useful: [nav.ts](../apps/web/src/features/control/nav.ts) supplies group membership and page labels, [router.ts](../apps/web/src/router.ts) supplies canonical addresses and legacy aliases, and search derives page entries from the navigation. Most page links already support browser navigation and opening in a new tab. Preserve this shared source of truth.

## Findings, in priority order

1. **Personal reader access is behind the administrator gate.** The only reader-token UI is rendered by ControlPanelPage, and App redirects non-admin sessions away from control routes. However, the token API explicitly manages the current user's own tokens, with no special administrator view. A regular member therefore lacks an appropriate UI for an existing account capability. Move it to a route such as `/profile/reader-access`, accessible from Profile and the ebook connection instructions. Preserve the server's existing account ownership and session restrictions. Evidence: [OpdsAccessSection.tsx](../apps/web/src/features/control/sections/OpdsAccessSection.tsx), [App.tsx](../apps/web/src/app/App.tsx), and [api-tokens.ts](../apps/server/src/core/api-tokens.ts).

2. **Dashboard combines destinations belonging to different tasks.** Checking disk health, reviewing a suspicious sign-in, and following a scan all require entering the same page and then choosing among six views. Overview opens on Sign-ins, while System is the last view. The page also displays its own view row below the Dashboard/Logs row. Move sign-in analysis into Security and task execution into Maintenance. Let the landing Dashboard answer server health and work needing attention. Evidence: [DashboardSection.tsx](../apps/web/src/features/control/sections/DashboardSection.tsx).

3. **Dashboard navigation has different browser behavior.** `chooseView` renders buttons and uses `history.replaceState`. The selected view can be bookmarked because it has a query parameter, but selecting views does not add Back/Forward steps, and those buttons cannot be opened in another tab. This is a deliberate implementation choice, but it is a poor fit for the independent destinations now inside Dashboard. Promote those destinations to normal links. Keep replacement behavior for appropriate filters and for canonicalizing old links. Evidence: [DashboardSection.tsx](../apps/web/src/features/control/sections/DashboardSection.tsx), especially `chooseView` and `dashboard-subtabs`.

4. **The same label leads to different places.** The shell's Settings link opens `/control/overview`, while the panel's Settings group opens `/control/settings`. Both appear in the desktop sidebar, including when already inside the panel. Rename the app-wide entrance to **Control panel**, and omit that redundant entrance within the panel. Retain the existing Home exit and Profile menu. Evidence: [DashboardShell.tsx](../apps/web/src/app/DashboardShell.tsx) and [control.json](../apps/web/src/locales/en/control.json).

5. **Utilities adds an inconsistent navigation level.** Six groups navigate to their first page; Utilities expands Gallery and Widgets branches, each then leading to its own page or tab row. A user must understand this special structure to reach cleanup or Quotes. These pages have clear homes under Maintenance and Settings. The branch expansion state is also initialized only on mount, so an in-app search jump from another group into a collapsed Utilities branch does not necessarily reveal its active child. A navigation refactor should derive active-group visibility from the current route. Evidence: [nav.ts](../apps/web/src/features/control/nav.ts) and [ControlPanelPage.tsx](../apps/web/src/features/control/ControlPanelPage.tsx).

6. **Search often stops at a page rather than the named setting.** Password policy, device linking policy, and deletion protection all resolve to the same Policies URL, despite having separate sections. Dashboard search entries can select views, but ordinary setting entries have no section target. Add stable section anchors and scroll/focus handling after the destination renders. Preserve search terms for former labels and both supported languages. Evidence: [search-index.ts](../apps/web/src/features/control/search-index.ts) and the named policy headings in [SecuritySection.tsx](../apps/web/src/features/control/sections/SecuritySection.tsx).

7. **Small-screen navigation needs a clearer entry point.** At 740px and below, the sidebar groups and nested branches become horizontal scrollers, with search after the groups. The page's own navigation still occupies another row. This is a source-level concern about discoverability; actual clipping and touch behavior need browser verification. Use one persistent Control panel menu button and a visible search trigger on phones, with the same group/page structure as desktop. Implement any menu dialog through the existing shared Modal, extending shared components if necessary. Evidence: [home.css](../apps/web/src/styles/home.css) and [ControlPanelPage.tsx](../apps/web/src/features/control/ControlPanelPage.tsx).

Documentation has also drifted: UI-CONVENTIONS specifies six groups, nav.ts specifies seven, and the user guide omits Storage contents and the Widgets/Quotes branch from its opening map. It also describes search and the control-panel entrance in older positions. Update these together when the final structure is implemented.

## Proposed destinations

Every current capability has a home below. The page order is deliberate: each group starts with its broadest or most frequently actionable destination.

| Group | Pages, in order | Purpose |
| --- | --- | --- |
| **Overview** | Dashboard, Activity, Library statistics, Logs | Understand current health and what happened |
| **Libraries & storage** | Libraries, Storage locations, Storage contents, Categories, Tags | Configure where content lives and how it is organized |
| **Members** | Accounts, Groups, Invite links | Manage household accounts and membership |
| **Security** | Security status, Sign-ins & devices, Sign-in locations, Policies, Trusted networks, Blocked IPs | Investigate access and configure protection |
| **Maintenance** | Tasks, Scheduled jobs, Backup & restore, Recycle bin, Duplicate cleanup, Missing photos | Follow work, recover data, and clean up |
| **Settings** | Appearance, Quotes, Stories, Maps, Email, Notifications, About | Configure app features, presentation, and services |

Outside the panel: **Profile → Reader access** manages the current person's OPDS tokens. Keep the existing Profile destinations for account details, personal security, appearance, sharing, and devices. Reader access should have its own URL even if the Devices page also links to it.

The proposed Dashboard reuses the current System health content as its starting point. Its summary can link directly to failed/running tasks, backup status, disk usage, and security status. Avoid reproducing the full analysis pages there. Sign-ins remains one page containing both sessions and attempts; this proposal does not resurrect the previously removed duplicate sign-in pages.

Storage locations is the existing Storage configuration page with a clearer label. Storage contents remains a separate destination because it shows app-managed files, owners, sizes, and orphan cleanup. Its description should clarify that it covers app storage, rather than implying a complete disk browser. Libraries stays first for established installations; an unconfigured installation should surface **Configure storage** as the next setup step.

Quotes belongs beside Appearance because it manages content used by the home widget. Its page should retain the concrete name **Quotes**. The existing personal Quotes page remains a separate consumer of that feature. Similarly, Settings → Appearance continues to mean server defaults, while Profile → Appearance means the current person's preferences.

## Navigation and links

Use a consistent two-level structure: **group → page**. On desktop, each group heading expands its page links; the active group opens automatically and the active page is marked. Other groups start collapsed and can be opened deliberately. Give every group the same behavior. Remove the horizontal row when it merely repeats those page links. Show the group and page in the content header, with a return link for deeper editors such as Categories → Edit category.

This replaces the current mixture of group links, Utilities branches, and Dashboard subnavigation. It also avoids turning Settings' seven pages or Maintenance's six pages into wider tab rows. It is a proposed change to the documented navigation pattern, so implementation must update UI-CONVENTIONS and the shared navigation component together. Existing content-level switches can remain where they are genuinely views of the same task.

Use actual anchors for destinations, `followRoute` for client navigation, and `aria-current="page"` on the current page link. Expansion controls should be buttons with `aria-expanded`. Destination links should use ordinary navigation semantics rather than `role="tab"`; true tab widgets need their associated panel and keyboard behavior.

Search should remain visible above the groups on desktop and beside the panel-menu trigger on phones. When entering through a search result, direct URL, or browser Back, reveal the destination in the menu. A setting search should both open its page and locate the named section.

Add or retain contextual links where the task naturally continues:

| Starting point | Useful next destination |
| --- | --- |
| Library scan started | Tasks filtered to that library |
| Scheduled job started | The corresponding task or filtered task list; retain the existing progress link |
| Failed task | Its library configuration, or the relevant schedule |
| Duplicate cleanup completed | Recycle bin filtered to cleanup removals and the applicable library when representable |
| Recycle bin | Storage locations for bin location; Scheduled jobs for expiry processing |
| Storage contents | Storage locations; the existing owner and gallery links |
| Suspicious sign-in | Blocked IPs, Policies, and Logs with the relevant scope |
| Security email alert setting | Email delivery configuration |
| Stories narration destination | The App files library section of Storage locations; retain the existing link and make it precise |
| Reader access | Ebook connection instructions and the person's device settings |

These are links to one canonical destination, not copies of forms. Some already exist, especially Tasks ↔ Scheduled jobs, Backup → Storage, Notifications → Email, and Stories → Storage. Extend those useful connections and preserve them during moves. Add typed URL helpers and destination filter support where a proposed scoped link is not currently available.

## Migration and verification

Implement in three reviewable steps:

1. Fix the duplicate Settings label and add personal Reader access. Add exact setting targets to search. These can ship independently of a larger menu change.
2. Implement uniform group/page navigation from the existing registry, move Utilities' pages, and extract Dashboard destinations using the existing view components. Keep stable section identifiers where possible. Update English and Russian labels, page headers, search breadcrumbs, and the conventions together.
3. Add workflow links and mobile navigation, then refresh guides and screenshots. Validate representative journeys before treating the new grouping as settled.

Canonical address examples for the extracted destinations:

| Existing destination | Proposed canonical address |
| --- | --- |
| Dashboard System view | `/control/overview` |
| Dashboard Activity view | `/control/overview/activity` |
| Dashboard Libraries view | `/control/overview/statistics` |
| Dashboard Tasks view | `/control/maintenance/tasks` |
| Dashboard Sign-ins view | `/control/security/sign-ins` |
| Dashboard Locations view | `/control/security/sign-in-locations` |
| Utilities Duplicate cleanup | `/control/maintenance/duplicate-cleanup` |
| Utilities Missing photos | `/control/maintenance/missing-photos` |
| Utilities Quotes | `/control/settings/quotes` |
| Settings Reader access | `/profile/reader-access` |

Retain all existing canonical paths and aliases as compatibility inputs when changing their destinations. Explicit Dashboard `?view=` links must still select the intended page; preserve applicable IP, person, location, and time filters. A bare `/control/overview` would intentionally become the health landing page. Canonicalization should replace history; navigation between destinations should push history. Resolve the former reader-access URL to Profile before the control-panel admin redirect so regular members can use old links too.

All 28 existing router tests passed with `npm run test:web -- test/router.test.ts`. They verify current path resolution and selected aliases, not the proposed navigation or interactive browser behavior.

For implementation, verify: every page appears exactly once in its primary group; old paths and Dashboard queries reach the intended destination; Back/Forward and opening in another tab work; search reveals the active group and exact section; member and admin reader-token access respects existing server rules; and the mobile menu works at phone widths in English and Russian. Exercise complete tasks such as creating a library and following its scan, investigating a sign-in, and restoring a cleanup removal. Run the applicable router/component checks, typecheck, and UI-convention check after application changes.
