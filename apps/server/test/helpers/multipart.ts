// Hand-built multipart/form-data bodies for app.inject(). No form-data library:
// the point of the upload tests is to send exactly the bytes a hostile client
// would, filenames with path separators included, and a library would "fix" them.

export interface Part {
  /** Form field name. */
  name?: string;
  /** Present for a file part; sent verbatim in Content-Disposition. */
  filename?: string;
  contentType?: string;
  data: Buffer | string;
}

export function multipart(parts: Part[], boundary = `----isputnik-test-${Math.random().toString(16).slice(2)}`) {
  const chunks: Buffer[] = [];
  for (const part of parts) {
    const disposition = `form-data; name="${part.name ?? "file"}"${part.filename != null ? `; filename="${part.filename}"` : ""}`;
    chunks.push(Buffer.from(
      `--${boundary}\r\nContent-Disposition: ${disposition}\r\n`
      + (part.contentType || part.filename != null ? `Content-Type: ${part.contentType ?? "application/octet-stream"}\r\n` : "")
      + "\r\n"
    ));
    chunks.push(Buffer.isBuffer(part.data) ? part.data : Buffer.from(part.data));
    chunks.push(Buffer.from("\r\n"));
  }
  chunks.push(Buffer.from(`--${boundary}--\r\n`));
  return {
    payload: Buffer.concat(chunks),
    headers: { "content-type": `multipart/form-data; boundary=${boundary}` }
  };
}
