import { useRef, useState, type ReactNode } from "react";
import { UploadCloud, FileUp } from "lucide-react";
import { Button } from "./Button";
import { MessageBox } from "./MessageBox";
import { formatBytes } from "./utils";

// The single way to upload a file. A drag-and-drop / pick dropzone that validates
// the client's choice against the same policy the server enforces (extensions +
// size), then streams it with a real progress bar (XMLHttpRequest — fetch can't
// report upload progress). Modal-agnostic content: drop it inside a shared Modal,
// or render it on a page. Each consumer passes its own endpoint + policy.
//
// On success the parsed JSON response is handed to onUploaded; the consumer decides
// what that means (close the dialog, refresh a list, …). onBusyChange lets a host
// Modal block dismissal while bytes are in flight.
export interface FileUploadProps {
  /** POST endpoint that accepts multipart/form-data. */
  endpoint: string;
  /** Allowed dotless, lowercase extensions, e.g. ["zip", "sqlite"]. */
  accept: string[];
  /** Client-side size cap in bytes, or null for no limit (mirror the server policy). */
  maxBytes?: number | null;
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

export function FileUpload({
  endpoint,
  accept,
  maxBytes = null,
  fieldName = "file",
  hint,
  onUploaded,
  onBusyChange
}: FileUploadProps) {
  const inputRef = useRef<HTMLInputElement>(null);
  const xhrRef = useRef<XMLHttpRequest | null>(null);
  const [dragging, setDragging] = useState(false);
  const [error, setError] = useState("");
  const [uploading, setUploading] = useState(false);
  const [progress, setProgress] = useState(0);
  const [activeName, setActiveName] = useState("");

  const acceptAttr = accept.map((ext) => `.${ext}`).join(",");
  const acceptLabel = accept.map((ext) => `.${ext}`).join(", ");

  const setBusy = (value: boolean) => {
    setUploading(value);
    onBusyChange?.(value);
  };

  const validate = (file: File): string => {
    const ext = extensionOf(file.name);
    if (!accept.map((value) => value.toLowerCase()).includes(ext)) {
      return `Choose a ${acceptLabel} file.`;
    }
    if (file.size === 0) return "That file is empty.";
    if (maxBytes != null && file.size > maxBytes) {
      return `That file is larger than the ${formatBytes(maxBytes)} limit.`;
    }
    return "";
  };

  const upload = (file: File) => {
    const form = new FormData();
    form.append(fieldName, file, file.name);

    const xhr = new XMLHttpRequest();
    xhrRef.current = xhr;
    xhr.open("POST", endpoint);
    xhr.withCredentials = true;
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
    setActiveName(file.name);
    setProgress(0);
    setBusy(true);
    xhr.send(form);
  };

  const begin = (file: File) => {
    const problem = validate(file);
    if (problem) {
      setError(problem);
      return;
    }
    upload(file);
  };

  const onDrop = (event: React.DragEvent) => {
    event.preventDefault();
    setDragging(false);
    if (uploading) return;
    const file = event.dataTransfer.files?.[0];
    if (file) begin(file);
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
            hidden
            onChange={(event) => {
              const file = event.target.files?.[0];
              event.target.value = ""; // allow re-picking the same file
              if (file) begin(file);
            }}
          />
          <span className="file-dropzone-icon" aria-hidden="true">
            <UploadCloud size={30} />
          </span>
          <p className="file-dropzone-title">Drag a file here, or</p>
          <Button variant="secondary" compact onClick={() => inputRef.current?.click()}>
            <FileUp size={16} /> Choose file
          </Button>
          <p className="file-dropzone-hint muted">{hint ?? `Accepted: ${acceptLabel}`}</p>
        </div>
      )}
      {error && <MessageBox tone="error" title="Upload failed">{error}</MessageBox>}
    </div>
  );
}
