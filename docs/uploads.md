# File uploads

This document describes the upload **process** — how a file gets from the user's
computer into the app — and the generic primitive every upload uses.

There is **one** upload path, shared by every module that accepts files (backups
today; library media and anything else later). A consumer supplies two things: a
**policy** (which extensions, how big) and a **receive** step (what to do with the
file). Everything in between — the dropzone, client checks, streaming transport,
size/extension enforcement, temp-file handling — is shared.

The rule that shapes the whole process: **the file is streamed straight to a temp
file on disk and never buffered in memory**, so a 600 MB audiobook costs the same
memory as a 1 KB note. Size and extension are enforced *while* streaming, and the
partial temp file is removed on every failure.

---

## The process, end to end

```
Browser — shared FileUpload                Server — route + receiveUpload()
─────────────────────────────             ──────────────────────────────────
1. user picks / drops a file
2. client pre-check: extension + size ─✗─> inline error, nothing sent
3. POST multipart/form-data (XHR) ─────────► 4. preHandler: authn / authz ─✗─► 401 / 403
   progress bar ← upload.onprogress          5. receiveUpload() streams the part
                                                to a temp file, enforcing:
                                                  · extension      ─✗─► 415  (temp removed)
                                                  · maxBytes mid-stream ─✗─► 413  (temp removed)
                                                  · empty / missing  ─✗─► 400  (temp removed)
                                             6. route validates content
                                                (e.g. a real backup) ─✗─► 400  (temp removed)
8. onUploaded(json) ◄── 201 + JSON ───────── 7. move temp → final home, logActivity, reply
   close modal, refresh list
```

1. **Pick / drop** — the shared `FileUpload` dropzone takes a drag-drop or a file
   picked through the button.
2. **Client pre-check** — the file's extension and size are validated against the
   same policy the server enforces, so an obviously-wrong file fails instantly with
   no upload. (This is convenience, not security — the server re-checks everything.)
3. **Send** — the file is POSTed as `multipart/form-data` using `XMLHttpRequest`
   (not `fetch`, which can't report upload progress); `upload.onprogress` drives the
   progress bar.
4. **Authorize** — the route's `preHandler` runs first (`app.requireAdmin`, or a
   library write-permission check). No file is read until access is granted.
5. **Stream + enforce** — `receiveUpload()` pipes the multipart part straight to a
   temp file, counting bytes as they arrive. A bad extension, an over-`maxBytes`
   stream, or an empty file is rejected and the partial temp file is deleted.
6. **Validate content** — the route inspects the finished temp file for anything its
   own format requires (a backup `.zip` must contain `database.sqlite`; a `.sqlite`
   must be a valid SQLite file). On failure the temp file is removed.
7. **Commit** — the temp file is moved into its final home, the action is logged, and
   the route replies (typically `201` with the created resource).
8. **Finish** — `FileUpload` hands the parsed JSON to the consumer's `onUploaded`,
   which closes the dialog and refreshes whatever list the upload fed.

**Guarantees:** never buffered in memory · extension + size enforced while streaming
· temp file removed on every failure path · one file per request.

---

## Per-target policy

The only thing that differs between consumers:

```ts
interface UploadPolicy {
  accept: string[];        // dotless, lowercase extensions, e.g. ["zip", "sqlite"]
  maxBytes: number | null; // hard cap, or null for no limit (enforced mid-stream)
}
```

- **Backup** uses a *static* policy: `{ accept: ["zip", "sqlite"], maxBytes: null }`
  (admin-only, uncapped — a trusted operator restoring a possibly-large backup).
- **A library** derives its policy from the library row: `settings_json
  .scan_extensions` for `accept`, `policy_json.maxUploadMB` for `maxBytes`, plus a
  write-permission check.

---

## Server contract — `apps/server/src/core/uploads.ts`

`@fastify/multipart` is registered once in `apps/server/src/index.ts` (one file per
request, no global size cap — the cap is per-policy).

```ts
interface ReceivedUpload { tmpPath; filename; extension; sizeBytes; }
class UploadError extends Error { statusCode: number; }

receiveUpload(request, policy, destDir): Promise<ReceivedUpload>
```

`UploadError.statusCode` maps straight onto the reply:

| Status | Meaning |
|---|---|
| `415` | Extension not in `policy.accept` (or not a multipart request) |
| `413` | Stream exceeded `policy.maxBytes` |
| `400` | No file part, or an empty file |

A route follows the same five beats every time:

```ts
app.post("/api/…/upload", { preHandler: app.requireAdmin }, async (request, reply) => {
  let received;
  try {
    received = await receiveUpload(request, policy, destDir);   // 5. stream + enforce
  } catch (err) {
    reply.code(err instanceof UploadError ? err.statusCode : 400)
         .send({ error: (err as Error).message });
    return;
  }
  try {
    /* 6. validate the file's contents */
  } catch (err) {
    fs.rmSync(received.tmpPath, { force: true });
    reply.code(400).send({ error: (err as Error).message });
    return;
  }
  /* 7. move received.tmpPath into place, logActivity, reply */
});
```

The route owns final placement **and** removing the temp file on its own errors;
`receiveUpload` only cleans up after the failures it raises.

---

## Web contract — `apps/web/src/shared/FileUpload.tsx`

One reusable dropzone: drag-and-drop + file picker, client-side extension/size
pre-check, and a progress bar via `XMLHttpRequest`. It is modal-agnostic content —
drop it inside a shared `Modal`.

```tsx
<FileUpload
  endpoint="/api/…"
  accept={["zip", "sqlite"]}
  maxBytes={null}
  onUploaded={(res) => …}     // parsed JSON response
  onBusyChange={setBusy}      // lets the host Modal block dismissal mid-upload
/>
```

---

## First consumer — backup upload

`POST /api/backups/upload` (admin, in `apps/server/src/core/backups.ts`):

1. `receiveUpload` with `{ accept: ["zip", "sqlite"], maxBytes: null }`.
2. Validates the file is a real isputnik backup (zip contains `database.sqlite`, or a
   valid `.sqlite`).
3. Stores it under the standard `isputnik-<stamp>.<ext>` name so it joins the backup
   list, and is then restorable like any other backup.

Wired into the Backup page via the shared `FileUpload` inside a `Modal`.

---

## Adding a new consumer

The uploader is generic; the work is the consumer's **receive** step. For **library
media**, the received file lands in the library's source folder and a scan is enqueued
to create the book record. That ingest — on-disk layout, single file vs. a whole
multi-track book folder, the scan trigger — is the real design surface, not the
transport, which is already done.
