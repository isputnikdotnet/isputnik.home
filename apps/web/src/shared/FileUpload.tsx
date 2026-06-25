import { useRef, useState, type ReactNode } from "react";
import { UploadCloud, FileUp, FolderUp } from "lucide-react";
import { Button } from "./Button";
import { MessageBox } from "./MessageBox";
import { formatBytes } from "./utils";
import { csrfToken } from "../api";

// The single way to upload a file. A drag-and-drop / pick dropzone that validates
// the client's choice against the same policy the server enforces (extensions +
// size), then streams it with a real progress bar (XMLHttpRequest — fetch can't
// report upload progress). Modal-agnostic content: drop it inside a shared Modal,
// or render it on a page. Each consumer passes its own endpoint + policy.
//
// With `multiple`, every picked/dropped file is sent in ONE multipart request
// (repeated entries under the same field name) — one progress bar for the batch,
// and the server treats the batch atomically (see core/uploads.ts).
//
// With `folders`, the user can also pick or drop a whole folder. Folder sources
// are filtered, not validated: files outside `accept` (covers, nfo, …) are
// skipped silently, like a library scan. Subfolders flatten into the filename
// ("CD1/01.mp3" → "CD1 - 01.mp3") so multi-disc rips upload without collisions,
// and the folder's name is reported to the endpoint via UploadBatch.
//
// On success the parsed JSON response is handed to onUploaded; the consumer decides
// what that means (close the dialog, refresh a list, …). onBusyChange lets a host
// Modal block dismissal while bytes are in flight.

// One file queued for upload; `name` is the filename sent to the server (it can
// carry a "Sub - " prefix when the file came from a subfolder).
interface UploadItem {
  file: File;
  name: string;
}

export interface UploadBatch {
  /** Final filenames, in upload order. */
  fileNames: string[];
  /** Name of the picked/dropped folder, when the batch came from one. */
  folderName: string | null;
}

export interface FileUploadProps {
  /** POST endpoint that accepts multipart/form-data — a fixed string, or a
   *  function of the batch (e.g. to carry the source folder name in the URL). */
  endpoint: string | ((batch: UploadBatch) => string);
  /** Allowed dotless, lowercase extensions, e.g. ["zip", "sqlite"]. */
  accept: string[];
  /** Client-side size cap in bytes per file, or null for no limit (mirror the server policy). */
  maxBytes?: number | null;
  /** Allow picking several files, all uploaded in a single request. */
  multiple?: boolean;
  /** Also offer picking/dropping a whole folder (needs `multiple`). */
  folders?: boolean;
  /** Upper bound on files per upload, or null for no limit (mirror the server policy). */
  maxFiles?: number | null;
  /** Multipart field name; defaults to "file". */
  fieldName?: string;
  /** Helper text under the dropzone; defaults to the accepted-types list. */
  hint?: ReactNode;
  onUploaded: (response: unknown) => void;
  /** Notifies the host when an upload starts/finishes (e.g. to block modal dismissal). */
  onBusyChange?: (busy: boolean) => void;
}

function extensionOf(name: string): string {
  const dot = name.lastIndexOf(".");
  return dot >= 0 ? name.slice(dot + 1).toLowerCase() : "";
}

function errorFromXhr(xhr: XMLHttpRequest): string {
  try {
    const payload = JSON.parse(xhr.responseText) as { error?: string };
    if (payload.error) return payload.error;
  } catch {
    /* non-JSON error body */
  }
  return `Upload failed (${xhr.status || "no response"}).`;
}

// readEntries delivers results in batches (Chrome: 100 at a time) — drain until
// it comes back empty.
function readAllEntries(dir: FileSystemDirectoryEntry): Promise<FileSystemEntry[]> {
  return new Promise((resolve, reject) => {
    const reader = dir.createReader();
    const all: FileSystemEntry[] = [];
    const next = () =>
      reader.readEntries((batch) => {
        if (batch.length === 0) resolve(all);
        else {
          all.push(...batch);
          next();
        }
      }, reject);
    next();
  });
}

function entryFile(entry: FileSystemFileEntry): Promise<File> {
  return new Promise((resolve, reject) => entry.file(resolve, reject));
}

// Walk a dropped folder, collecting accepted files. Subfolder names join the
// filename so the upload is flat; hidden entries are skipped like in a scan.
// Collection stops just past `cap` — the caller turns that into a clear error.
async function collectFolderEntry(
  dir: FileSystemDirectoryEntry,
  parts: string[],
  acceptSet: Set<string>,
  cap: number,
  out: UploadItem[]
): Promise<void> {
  for (const child of await readAllEntries(dir)) {
    if (out.length > cap) return;
    if (child.name.startsWith(".")) continue;
    if (child.isFile) {
      if (!acceptSet.has(extensionOf(child.name))) continue;
      const file = await entryFile(child as FileSystemFileEntry);
      out.push({ file, name: [...parts, file.name].join(" - ") });
    } else if (child.isDirectory) {
      await collectFolderEntry(child as FileSystemDirectoryEntry, [...parts, child.name], acceptSet, cap, out);
    }
  }
}

export function FileUpload({
  endpoint,
  accept,
  maxBytes = null,
  multiple = false,
  folders = false,
  maxFiles = null,
  fieldName = "file",
  hint,
  onUploaded,
  onBusyChange
}: FileUploadProps) {
  const inputRef = useRef<HTMLInputElement>(null);
  const folderInputRef = useRef<HTMLInputElement>(null);
  const xhrRef = useRef<XMLHttpRequest | null>(null);
  const [dragging, setDragging] = useState(false);
  const [error, setError] = useState("");
  const [uploading, setUploading] = useState(false);
  const [progress, setProgress] = useState(0);
  const [activeName, setActiveName] = useState("");

  const acceptAttr = accept.map((ext) => `.${ext}`).join(",");
  const acceptLabel = accept.map((ext) => `.${ext}`).join(", ");
  const acceptSet = new Set(accept.map((ext) => ext.toLowerCase()));

  const setBusy = (value: boolean) => {
    setUploading(value);
    onBusyChange?.(value);
  };

  const upload = (items: UploadItem[], folderName: string | null) => {
    const url = typeof endpoint === "function"
      ? endpoint({ fileNames: items.map((item) => item.name), folderName })
      : endpoint;
    const form = new FormData();
    for (const item of items) {
      form.append(fieldName, item.file, item.name);
    }

    const xhr = new XMLHttpRequest();
    xhrRef.current = xhr;
    xhr.open("POST", url);
    xhr.withCredentials = true;
    const token = csrfToken();
    if (token) xhr.setRequestHeader("X-CSRF-Token", token);
    xhr.upload.onprogress = (event) => {
      if (event.lengthComputable) setProgress(Math.round((event.loaded / event.total) * 100));
    };
    xhr.onload = () => {
      xhrRef.current = null;
      setBusy(false);
      if (xhr.status >= 200 && xhr.status < 300) {
        let payload: unknown = {};
        try {
          payload = JSON.parse(xhr.responseText);
        } catch {
          /* tolerate an empty body */
        }
        onUploaded(payload);
      } else {
        setError(errorFromXhr(xhr));
      }
    };
    xhr.onerror = () => {
      xhrRef.current = null;
      setBusy(false);
      setError("Network error during upload.");
    };
    xhr.onabort = () => {
      xhrRef.current = null;
      setBusy(false);
    };

    setError("");
    setActiveName(items.length === 1
      ? items[0].name
      : `${items.length} files (${formatBytes(items.reduce((total, item) => total + item.file.size, 0))})`);
    setProgress(0);
    setBusy(true);
    xhr.send(form);
  };

  const tooMany = () => `Too many files — at most ${maxFiles} per upload.`;

  // Explicitly picked files: an unsupported pick is the user's mistake — fail loudly.
  const beginFiles = (picked: File[]) => {
    const files = multiple ? picked : picked.slice(0, 1);
    for (const file of files) {
      const problem = !acceptSet.has(extensionOf(file.name))
        ? `Choose a ${acceptLabel} file.`
        : file.size === 0
          ? "That file is empty."
          : maxBytes != null && file.size > maxBytes
            ? `That file is larger than the ${formatBytes(maxBytes)} limit.`
            : "";
      if (problem) {
        setError(files.length > 1 ? `${file.name}: ${problem}` : problem);
        return;
      }
    }
    if (maxFiles != null && files.length > maxFiles) {
      setError(tooMany());
      return;
    }
    if (files.length > 0) upload(files.map((file) => ({ file, name: file.name })), null);
  };

  // A folder source: keep only accepted, non-empty files (covers/nfo are skipped
  // silently, like a library scan) and upload them in name order.
  const beginFolder = (items: UploadItem[], folderName: string | null) => {
    const usable = items
      .filter((item) => acceptSet.has(extensionOf(item.name)) && item.file.size > 0)
      .sort((left, right) => left.name.localeCompare(right.name, undefined, { numeric: true }));
    if (usable.length === 0) {
      setError(`No ${acceptLabel} files found in that folder.`);
      return;
    }
    if (maxFiles != null && usable.length > maxFiles) {
      setError(tooMany());
      return;
    }
    const oversize = maxBytes != null ? usable.find((item) => item.file.size > maxBytes) : undefined;
    if (oversize) {
      setError(`${oversize.name}: larger than the ${formatBytes(maxBytes!)} limit.`);
      return;
    }
    upload(usable, folderName);
  };

  // Folder picked via the webkitdirectory input: relative paths come on each file.
  const beginFolderPick = (files: File[]) => {
    setError("");
    let folderName: string | null = null;
    const items = files
      .filter((file) => !file.name.startsWith("."))
      .map((file) => {
        const parts = (file.webkitRelativePath || file.name).split("/");
        if (parts.length > 1) folderName = folderName ?? parts[0];
        return { file, name: parts.length > 2 ? parts.slice(1).join(" - ") : file.name };
      });
    beginFolder(items, folderName);
  };

  const onDrop = (event: React.DragEvent) => {
    event.preventDefault();
    setDragging(false);
    if (uploading) return;
    const transfer = event.dataTransfer;
    // Entries must be grabbed synchronously — the DataTransfer is gone after an await.
    const dropped = folders
      ? Array.from(transfer.items).map((item) => ({ entry: item.webkitGetAsEntry?.() ?? null, file: item.getAsFile() }))
      : [];
    if (!dropped.some((item) => item.entry?.isDirectory)) {
      beginFiles(Array.from(transfer.files ?? []));
      return;
    }
    setError("");
    void (async () => {
      try {
        const items: UploadItem[] = [];
        let folderName: string | null = null;
        const cap = maxFiles ?? 1000;
        for (const { entry, file } of dropped) {
          if (entry?.isDirectory) {
            folderName = folderName ?? entry.name;
            await collectFolderEntry(entry as FileSystemDirectoryEntry, [], acceptSet, cap, items);
          } else if (file) {
            items.push({ file, name: file.name });
          }
        }
        beginFolder(items, folderName);
      } catch {
        setError("Could not read the dropped folder.");
      }
    })();
  };

  return (
    <div className="file-upload">
      {uploading ? (
        <div className="file-upload-active">
          <div className="file-upload-row">
            <span className="file-upload-name">{activeName}</span>
            <span className="file-upload-pct">{progress}%</span>
          </div>
          <div className="file-upload-track" role="progressbar" aria-valuenow={progress} aria-valuemin={0} aria-valuemax={100}>
            <div className="file-upload-fill" style={{ width: `${progress}%` }} />
          </div>
          <div className="file-upload-actions">
            <Button variant="text" onClick={() => xhrRef.current?.abort()}>Cancel upload</Button>
          </div>
        </div>
      ) : (
        <div
          className={`file-dropzone${dragging ? " dragging" : ""}`}
          onDragOver={(event) => {
            event.preventDefault();
            setDragging(true);
          }}
          onDragLeave={() => setDragging(false)}
          onDrop={onDrop}
        >
          <input
            ref={inputRef}
            type="file"
            accept={acceptAttr}
            multiple={multiple}
            hidden
            onChange={(event) => {
              const files = Array.from(event.target.files ?? []);
              event.target.value = ""; // allow re-picking the same file
              if (files.length > 0) beginFiles(files);
            }}
          />
          {folders && (
            <input
              // webkitdirectory isn't in React's typed props — set it on the node.
              ref={(element) => {
                folderInputRef.current = element;
                element?.setAttribute("webkitdirectory", "");
              }}
              type="file"
              hidden
              onChange={(event) => {
                const files = Array.from(event.target.files ?? []);
                event.target.value = "";
                if (files.length > 0) beginFolderPick(files);
              }}
            />
          )}
          <span className="file-dropzone-icon" aria-hidden="true">
            <UploadCloud size={30} />
          </span>
          <p className="file-dropzone-title">
            {folders ? "Drag files or a folder here, or" : multiple ? "Drag files here, or" : "Drag a file here, or"}
          </p>
          <div className="file-dropzone-buttons">
            <Button variant="secondary" compact onClick={() => inputRef.current?.click()}>
              <FileUp size={16} /> {multiple ? "Choose files" : "Choose file"}
            </Button>
            {folders && (
              <Button variant="secondary" compact onClick={() => folderInputRef.current?.click()}>
                <FolderUp size={16} /> Choose folder
              </Button>
            )}
          </div>
          <p className="file-dropzone-hint muted">{hint ?? `Accepted: ${acceptLabel}`}</p>
        </div>
      )}
      {error && <MessageBox tone="error" title="Upload failed">{error}</MessageBox>}
    </div>
  );
}
