# Improving control panel libraries

Reviewed November 6, 2026. Proposal only; no application behavior changed.

## Interactive mockup

The proposal is illustrated by a standalone mockup using fictional data:

- [Open the private interactive preview](https://isputnik-library-layout.sergeym409434.chatgpt.site)
- [Open the local HTML mockup](mockups/library-control-panel/dist/index.html)
- [Libraries screenshot](mockups/library-control-panel-preview/libraries.png)
- [Organization screenshot](mockups/library-control-panel-preview/organization.png)
- [Device Sync screenshot](mockups/library-control-panel-preview/device-sync.png)
- [Storage screenshot](mockups/library-control-panel-preview/storage.png)
- [App storage contents screenshot](mockups/library-control-panel-preview/contents.png)

The five tabs, sample dialogs, filtering and responsive layouts were checked in a
browser at desktop and mobile sizes. The mockup does not connect to the live app.

## Review scope

Based on the current navigation, page components, server routes, user guides, and
the saved Libraries and Storage screenshots. The screenshots predate some current
tabs; source code is the authority for current behavior. No live browser walkthrough
or usability testing was performed.

## Findings

1. **The tab row mixes tasks and scopes.** Libraries, Storage, Storage contents,
   Categories, Tags, and Video genres appear as equivalent destinations. Categories
   applies to ebooks and audiobooks, Tags spans several kinds of content, and video
   genres belongs to movies and shows. The relationship has to be learned rather
   than being explained at the point of use.
2. **Storage terminology obscures the hierarchy.** A storage container is an
   approved root folder, a library is a catalog of a folder's media, System data
   holds derived/supporting files, and App storage holds app-managed content. The
   word "container" also describes the separately running apps elsewhere in the
   panel. Storage contents covers App storage, not everything under Storage.
3. **Phone backup setup crosses unrelated pages.** Personal-library eligibility,
   destination and quota are at the bottom of Storage; allowed networks, server
   address and phone status are in Security → Phone sync. A gallery library's Phone
   backups editor handles links used to avoid sending existing photos again.
   These are related steps without a single setup overview.
4. **The library list repeats too many actions.** A manageable row can show scan
   rules or faces, members, edit, rescan, and delete, plus a separate information
   button. The important identity and status compete with five action icons.
5. **Tags has a concrete scope/count mismatch.** The client only declares and uses
   `bookCount`, including for its "Remove unused" count and delete explanation.
   The server also returns `otherCount`. Despite its name, `bookCount` actually
   counts active `library_item` assignments, including Gallery; `otherCount` counts
   other entity assignments. A tag used only by a story or person therefore appears
   unused to the client. Server pruning checks both counts, so this is misleading
   UI rather than evidence that pruning deletes those used tags. Merely renaming
   the column will not fix it.

Evidence: [navigation](../apps/web/src/features/control/nav.ts),
[Libraries](../apps/web/src/features/control/sections/LibrariesSection.tsx),
[Storage](../apps/web/src/features/control/sections/StorageSection.tsx),
[Storage contents](../apps/web/src/features/control/sections/StorageContentsSection.tsx),
[Phone sync](../apps/web/src/features/control/sections/PhoneSyncSection.tsx),
[Tags client](../apps/web/src/features/control/sections/TagsSection.tsx), and
[tag management routes](../apps/server/src/modules/library/audiobook/categories-routes.ts).

## Recommended structure

Keep the existing six control-panel groups. Within Library, use one row of five
tabs, in this order:

| Tab | Question it answers | Contents |
| --- | --- | --- |
| Libraries | What media libraries do we have? | Library list, creation, access, scanning and type-specific configuration |
| Organization | How is content labeled and grouped? | Three compact entries: Book categories, Tags, Video genres, each with its scope and a Manage link |
| Device Sync | Can members back up their devices, and is it working? | Personal libraries, destination, eligibility, quota, network rules, server address and device status |
| Storage | Where are files kept? | Library locations, System data, App storage; a summary/link for the personal-library destination |
| App storage contents | What is using app-managed space? | Existing contents inventory, ownership and orphan cleanup |

This reduces the Library row from six tabs to five while bringing phone setup into
the same group. Keep contents separate: embedding its inventory in Storage would
make an already long setup page longer. Give App storage a direct "View contents"
link and the inventory a "Storage settings" link.

Organization should show three short entries, not three expanded management tables
and not a second tab row. Their existing editors remain directly addressable;
opening one keeps Organization selected, with a clear return link. This requires
an explicit extension to the current rule that every control section is a top-level
tab: define child editor routes separately in navigation metadata, keep their search
entries, and update the navigation conventions with the implementation. Preserve
the six groups and one tab row throughout.

### Make applicability explicit

| Tool | Applies to |
| --- | --- |
| Book categories | Ebooks and audiobooks; one shared set |
| Tags | Ebooks, audiobooks, Gallery items, albums, slideshows, stories and family-tree people |
| Video genres | Movies and TV shows in Video libraries |

Gallery video clips can carry tags. The exception is the separate Video library
feature, so avoid the overly broad phrase "tags do not work on videos."

Add relevant Organization shortcuts beside the library type filter or inside its
editor. A book library links to Book categories and Tags; a Gallery library links
to Tags; a Video library links to Video genres. Say that the editor manages a shared
set, so entering from one library does not imply changes affect only that library.

### Simplify Storage

Rename **Digital Library containers → Library locations**. In the folder picker,
use **Location** and **Folder within location**, followed by the resolved path.
Explain once: "Folders on this server that libraries are allowed to use."

For example:

```text
Library location: Family media   /media
  Audiobooks                    /media/Audiobooks
  Ebooks                        /media/Ebooks
  Family photos                 /media/Photos

System data                     /config
App storage                     /config/app-storage
```

These are examples, not a required disk layout. System data and App storage may
use custom folders outside library locations. Video library folders are resolved
by the video engine; retain that distinction and its existing picker.

Each configured storage block should lead with its path, status/free space, and
one Change action. Put individual folder overrides and explanatory details behind
an expansion. Keep missing setup, failed moves and space warnings visible.
Personal-library policy belongs on Device Sync; Storage shows its destination
and links to that configuration rather than offering a second editable copy.

### Give Device Sync a complete workflow

Use **Device Sync** as the destination name (user preference, November 6, 2026).
Suggested description: "Back up photos and videos from your devices to personal
libraries, and check their connection status." Explain that the current transfer
is one-way: deleting a photo on a device does not delete the server copy. Keep
"Phone sync", "Phone backups", and "PhotoSync" as search terms for discoverability.

When incomplete, show a short setup checklist:

1. Allow personal libraries; choose eligible members, destination and quota.
2. Set allowed phone networks and the address phones use.
3. Explain the member's next step: Profile → My library, then add a phone.

After setup, lead with phones needing attention and recent contact; retain compact
configuration summaries with Edit actions. Personal libraries can exist without a
phone: label that section explicitly and keep it searchable by its own name.

Security should link to the canonical phone-network editor. Its allowlist remains
independent of sign-in Trusted networks. Profile remains the place for a member's
own library and credentials. Existing private-library boundaries remain in force:
admins get operational status and size, not members' media or media counts.
Keep gallery-to-phone links in the relevant library editor and link to them from
phone status. Logs remains the history destination.

### Quiet the library list

Use name/type, access, size/items where permitted, and status as the main row
information. Keep a labeled **Manage** action and a secondary menu for rescanning
and deletion. Group access, scanning, faces and phone links in the management
surface, showing only the settings supported by that type. Keep active scan
progress visible, with its link to Tasks. Preserve permission-dependent actions
and the restricted summary for someone else's personal library.

## Implementation order and verification

1. Correct Tags usage counts, unused detection and delete wording using both server
   counts. Update the book-specific help/empty-state text. Test a Gallery-only tag
   and a story/person-only tag, plus a truly unused tag, including privacy behavior.
2. Apply the scoped names and Storage summary layout; reduce library row actions.
3. Introduce Organization and its child editors, then consolidate Device Sync.
   Reuse existing policy and status components rather than duplicating settings.
4. Preserve legacy URLs and search terms, update typed links and anchor targets,
   mirror English/Russian keys, and revise the affected user guides/screenshots and
   UI conventions. Update the existing guide entries rather than adding this
   internal review to in-app Help.

For implementation, run `npm run typecheck`, `npm run check:ui`, and relevant tests
through the repository's safe scripts. Verify old bookmarks, browser Back/Forward,
search links into child editors, mobile navigation, video-engine unavailability,
and member/admin privacy. Walk through adding an ebook library, organizing a video
library, setting up a first phone, diagnosing a refused phone, and finding an
orphaned app file. No tests were run for this documentation-only review.
