import fsp from "node:fs/promises";
import path from "node:path";
import type { FastifyInstance, FastifyReply, FastifyRequest, RouteShorthandOptions } from "fastify";
import { nowIso, type User } from "../../../db.js";
import { resolveApiToken } from "../../../core/api-tokens.js";
import { thumbnailAbsolutePath } from "../shared/thumbnail.js";
import { streamDocumentFile } from "../shared/document-stream.js";
import { resolveEbookScopeLibraryIds, queryEbookCatalog, ebookCatalogFacets } from "./catalog.js";

// OPDS 1.2 (Atom) catalog for the ebook libraries. Readers (KOReader, Thorium,
// Moon+, …) browse and download over this surface. It authenticates with a
// personal access token — never the session cookie — accepted EITHER as the first
// path segment (/opds/<token>/…, one-paste for any client) OR as the HTTP Basic
// password against the plain /opds URL. Generated links preserve whichever style
// the caller used so paging/sub-feeds keep working.

declare module "fastify" {
  interface FastifyRequest {
    opdsUser?: User;
    // The raw token when authenticated via the path; null when via Basic auth.
    opdsTokenInPath?: string | null;
  }
}

const NAV_TYPE = "application/atom+xml;profile=opds-catalog;kind=navigation";
const ACQ_TYPE = "application/atom+xml;profile=opds-catalog;kind=acquisition";
const PAGE_SIZE = 50;

// Generous per-IP ceiling: a single catalog page fans out into one feed request
// plus up to PAGE_SIZE cover fetches, so this must comfortably exceed that. Token
// entropy (~190 bits) is the real defence against guessing; this just bounds abuse.
const OPDS_ROUTE_OPTS: RouteShorthandOptions = {
  preHandler: opdsAuth,
  config: { rateLimit: { max: 600, timeWindow: "1 minute" } }
};

const FORMAT_MIME: Record<string, string> = {
  epub: "application/epub+zip",
  pdf: "application/pdf",
  cbz: "application/vnd.comicbook+zip",
  cbr: "application/vnd.comicbook-rar",
  mobi: "application/x-mobipocket-ebook",
  azw3: "application/vnd.amazon.ebook",
  fb2: "application/x-fictionbook+xml",
  txt: "text/plain"
};

const COVER_MIME: Record<string, string> = {
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".png": "image/png",
  ".webp": "image/webp"
};

// The fields the OPDS feed reads off a mapped catalog row (see mapEbookRow).
interface EbookListItem {
  id: string;
  title: string;
  authors: string[];
  category: { key: string; name: string } | null;
  language: string | null;
  format: string | null;
  documentId: string | null;
  // Every available format of the book — one acquisition link is emitted per entry.
  documents: { id: string; format: string }[];
  yearPublished: number | null;
  coverUrl: string | null;
  updatedAt: string;
}

export interface LinkCtx {
  origin: string;
  tokenInPath: string | null;
}

export interface AcquisitionSpec {
  base: string;
  title: string;
  id: string;
  sort: "title" | "recent";
}

export interface FacetSpec {
  base: string;
  title: string;
  id: string;
  facetKey: "authors" | "categories" | "languages";
  param: string;
}

function escapeXml(value: string): string {
  return value.replace(/[<>&'"]/g, (ch) =>
    ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", "'": "&apos;", '"': "&quot;" })[ch] as string
  );
}

function linkCtx(request: FastifyRequest): LinkCtx {
  return {
    origin: `${request.protocol}://${request.headers.host}`,
    tokenInPath: request.opdsTokenInPath ?? null
  };
}

// Absolute URL for an OPDS sub-path, re-inserting the path token when that's how
// the caller authenticated.
function opdsHref(ctx: LinkCtx, suffix: string): string {
  const base = ctx.tokenInPath ? `/opds/${ctx.tokenInPath}` : "/opds";
  return `${ctx.origin}${base}${suffix}`;
}

// Build an acquisition sub-path suffix carrying the active filter + page.
function acqSuffix(base: string, query: Record<string, string | undefined>, page: number): string {
  const params = new URLSearchParams();
  for (const key of ["q", "author", "category", "language"]) {
    if (query[key]) params.set(key, query[key] as string);
  }
  if (page > 0) params.set("page", String(page));
  const qs = params.toString();
  return qs ? `${base}?${qs}` : base;
}

// ── Authentication ──────────────────────────────────────────────────────────

async function opdsAuth(request: FastifyRequest, reply: FastifyReply): Promise<void> {
  const tokenParam = (request.params as { token?: string }).token;
  let raw: string | null = null;
  let inPath = false;

  if (tokenParam) {
    raw = tokenParam;
    inPath = true;
  } else {
    const auth = request.headers.authorization;
    if (auth && auth.toLowerCase().startsWith("basic ")) {
      try {
        const decoded = Buffer.from(auth.slice(6).trim(), "base64").toString("utf8");
        const colon = decoded.indexOf(":");
        // Username is ignored; only the password (the token) is validated.
        raw = colon >= 0 ? decoded.slice(colon + 1) : decoded;
      } catch {
        raw = null;
      }
    }
  }

  const user = raw ? resolveApiToken(raw, "opds", request.ip) : null;
  if (!user) {
    reply
      .code(401)
      .header("WWW-Authenticate", 'Basic realm="isputnik OPDS", charset="UTF-8"')
      .type("text/plain")
      .send("OPDS authentication required");
    return;
  }

  request.opdsUser = user;
  request.opdsTokenInPath = inPath ? raw : null;
}

// ── XML builders ────────────────────────────────────────────────────────────

const FEED_NS = [
  'xmlns="http://www.w3.org/2005/Atom"',
  'xmlns:dcterms="http://purl.org/dc/terms/"',
  'xmlns:opds="http://opds-spec.org/2010/catalog"',
  'xmlns:opensearch="http://a9.com/-/spec/opensearch/1.1/"'
].join(" ");

function feedHead(kind: "navigation" | "acquisition", id: string, title: string, ctx: LinkCtx, selfSuffix: string, upSuffix?: string): string {
  const selfType = kind === "navigation" ? NAV_TYPE : ACQ_TYPE;
  const links = [
    `<link rel="self" type="${selfType}" href="${escapeXml(opdsHref(ctx, selfSuffix))}"/>`,
    `<link rel="start" type="${NAV_TYPE}" href="${escapeXml(opdsHref(ctx, ""))}"/>`,
    upSuffix !== undefined ? `<link rel="up" type="${NAV_TYPE}" href="${escapeXml(opdsHref(ctx, upSuffix))}"/>` : "",
    `<link rel="search" type="application/opensearchdescription+xml" href="${escapeXml(opdsHref(ctx, "/opensearch.xml"))}"/>`
  ].join("");
  return `<id>${escapeXml(id)}</id><title>${escapeXml(title)}</title><updated>${nowIso()}</updated>${links}`;
}

interface NavEntry {
  id: string;
  title: string;
  href: string;
  rel: string;
  type: string;
  content?: string;
}

function renderNavEntry(entry: NavEntry): string {
  const content = entry.content ? `<content type="text">${escapeXml(entry.content)}</content>` : "";
  return `<entry><title>${escapeXml(entry.title)}</title><id>${escapeXml(entry.id)}</id><updated>${nowIso()}</updated>`
    + `<link rel="${entry.rel}" type="${entry.type}" href="${escapeXml(entry.href)}"/>${content}</entry>`;
}

function renderNavFeed(opts: { id: string; title: string; ctx: LinkCtx; selfSuffix: string; upSuffix?: string; entries: string[] }): string {
  return `<?xml version="1.0" encoding="UTF-8"?>\n<feed ${FEED_NS}>\n`
    + feedHead("navigation", opts.id, opts.title, opts.ctx, opts.selfSuffix, opts.upSuffix)
    + `\n${opts.entries.join("\n")}\n</feed>`;
}

function renderBookEntry(book: EbookListItem, ctx: LinkCtx): string {
  const parts: string[] = [
    `<title>${escapeXml(book.title)}</title>`,
    `<id>urn:isputnik:item:${escapeXml(book.id)}</id>`,
    `<updated>${escapeXml(book.updatedAt ?? nowIso())}</updated>`
  ];
  for (const author of book.authors) parts.push(`<author><name>${escapeXml(author)}</name></author>`);
  if (book.language) parts.push(`<dcterms:language>${escapeXml(book.language)}</dcterms:language>`);
  if (book.yearPublished) parts.push(`<dcterms:issued>${book.yearPublished}</dcterms:issued>`);
  if (book.category) parts.push(`<category term="${escapeXml(book.category.name)}" label="${escapeXml(book.category.name)}"/>`);

  if (book.coverUrl) {
    const key = book.coverUrl.replace(/^\/api\/library\/covers\//, "");
    const href = escapeXml(opdsHref(ctx, `/cover/${key}`));
    const mime = COVER_MIME[path.extname(key).toLowerCase()] ?? "image/jpeg";
    parts.push(`<link rel="http://opds-spec.org/image" type="${mime}" href="${href}"/>`);
    parts.push(`<link rel="http://opds-spec.org/image/thumbnail" type="${mime}" href="${href}"/>`);
  }

  // One acquisition link per available format, so a reader picks the one it supports.
  for (const doc of book.documents) {
    const acqType = FORMAT_MIME[doc.format] ?? "application/octet-stream";
    const href = escapeXml(opdsHref(ctx, `/document/${book.id}/${doc.id}`));
    parts.push(`<link rel="http://opds-spec.org/acquisition" type="${acqType}" href="${href}"/>`);
  }

  return `<entry>${parts.join("")}</entry>`;
}

function renderAcquisitionFeed(opts: {
  id: string;
  title: string;
  ctx: LinkCtx;
  selfSuffix: string;
  nextSuffix?: string;
  prevSuffix?: string;
  total: number;
  entries: string[];
}): string {
  const pageLinks = [
    opts.nextSuffix ? `<link rel="next" type="${ACQ_TYPE}" href="${escapeXml(opdsHref(opts.ctx, opts.nextSuffix))}"/>` : "",
    opts.prevSuffix ? `<link rel="previous" type="${ACQ_TYPE}" href="${escapeXml(opdsHref(opts.ctx, opts.prevSuffix))}"/>` : ""
  ].join("");
  return `<?xml version="1.0" encoding="UTF-8"?>\n<feed ${FEED_NS}>\n`
    + feedHead("acquisition", opts.id, opts.title, opts.ctx, opts.selfSuffix, "")
    + `<opensearch:totalResults>${opts.total}</opensearch:totalResults>${pageLinks}`
    + `\n${opts.entries.join("\n")}\n</feed>`;
}

// ── Handlers ────────────────────────────────────────────────────────────────

// Pure feed builders — decoupled from request/reply so they can be unit-tested
// with a synthesized LinkCtx. The route handlers below are thin wrappers.

export function buildRootNav(ctx: LinkCtx): string {
  const entries = [
    renderNavEntry({ id: "urn:isputnik:ebooks:recent", title: "Recently added", rel: "subsection", type: ACQ_TYPE, href: opdsHref(ctx, "/recent"), content: "The latest ebooks" }),
    renderNavEntry({ id: "urn:isputnik:ebooks:all", title: "All ebooks", rel: "subsection", type: ACQ_TYPE, href: opdsHref(ctx, "/all"), content: "Every ebook you can access, by title" }),
    renderNavEntry({ id: "urn:isputnik:ebooks:authors", title: "By author", rel: "subsection", type: NAV_TYPE, href: opdsHref(ctx, "/authors") }),
    renderNavEntry({ id: "urn:isputnik:ebooks:categories", title: "By category", rel: "subsection", type: NAV_TYPE, href: opdsHref(ctx, "/categories") }),
    renderNavEntry({ id: "urn:isputnik:ebooks:languages", title: "By language", rel: "subsection", type: NAV_TYPE, href: opdsHref(ctx, "/languages") })
  ];
  return renderNavFeed({ id: "urn:isputnik:ebooks", title: "isputnik ebooks", ctx, selfSuffix: "", entries });
}

export function buildAcquisitionFeed(
  user: { id: string; role: string },
  ctx: LinkCtx,
  spec: AcquisitionSpec,
  query: Record<string, string | undefined>
): string {
  const page = Math.max(0, Number.parseInt(query.page ?? "0", 10) || 0);
  const offset = page * PAGE_SIZE;

  const libIds = resolveEbookScopeLibraryIds(user, "all");
  const { books, total } = queryEbookCatalog(user.id, libIds, {
    q: query.q ?? "",
    sort: spec.sort,
    limit: PAGE_SIZE,
    offset,
    filters: {
      authors: query.author ? [query.author] : [],
      narrators: [],
      categories: query.category ? [query.category] : [],
      tags: [],
      series: [],
      languages: query.language ? [query.language] : [],
      status: [],
      durations: []
    }
  });

  const items = books as EbookListItem[];
  const hasNext = offset + items.length < total;
  return renderAcquisitionFeed({
    id: spec.id,
    title: spec.title,
    ctx,
    selfSuffix: acqSuffix(spec.base, query, page),
    nextSuffix: hasNext ? acqSuffix(spec.base, query, page + 1) : undefined,
    prevSuffix: page > 0 ? acqSuffix(spec.base, query, page - 1) : undefined,
    total,
    entries: items.map((book) => renderBookEntry(book, ctx))
  });
}

export function buildFacetNav(user: { id: string; role: string }, ctx: LinkCtx, spec: FacetSpec): string {
  const libIds = resolveEbookScopeLibraryIds(user, "all");
  const values = ebookCatalogFacets(libIds)[spec.facetKey] ?? [];
  const entries = values.map((value) =>
    renderNavEntry({
      id: `urn:isputnik:${spec.facetKey}:${encodeURIComponent(value)}`,
      title: value,
      rel: "subsection",
      type: ACQ_TYPE,
      href: opdsHref(ctx, acqSuffix("/all", { [spec.param]: value }, 0))
    })
  );
  return renderNavFeed({ id: spec.id, title: spec.title, ctx, selfSuffix: spec.base, upSuffix: "", entries });
}

function rootNav(request: FastifyRequest, reply: FastifyReply): void {
  reply.type(NAV_TYPE).send(buildRootNav(linkCtx(request)));
}

function acquisitionHandler(spec: AcquisitionSpec) {
  return (request: FastifyRequest, reply: FastifyReply): void => {
    reply.type(ACQ_TYPE).send(buildAcquisitionFeed(request.opdsUser!, linkCtx(request), spec, request.query as Record<string, string | undefined>));
  };
}

function facetNavHandler(spec: FacetSpec) {
  return (request: FastifyRequest, reply: FastifyReply): void => {
    reply.type(NAV_TYPE).send(buildFacetNav(request.opdsUser!, linkCtx(request), spec));
  };
}

function opensearchHandler(request: FastifyRequest, reply: FastifyReply): void {
  const ctx = linkCtx(request);
  const template = `${opdsHref(ctx, "/search")}?q={searchTerms}`;
  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<OpenSearchDescription xmlns="http://a9.com/-/spec/opensearch/1.1/">
  <ShortName>isputnik ebooks</ShortName>
  <Description>Search the ebook library</Description>
  <InputEncoding>UTF-8</InputEncoding>
  <Url type="${ACQ_TYPE}" template="${escapeXml(template)}"/>
</OpenSearchDescription>`;
  reply.type("application/opensearchdescription+xml").send(xml);
}

function documentHandler(request: FastifyRequest, reply: FastifyReply): void {
  const { itemId, docId } = request.params as { itemId: string; docId: string };
  // OPDS acquisition is always a download — enforce the library's download policy.
  streamDocumentFile(request, reply, { itemId, docId, user: request.opdsUser!, download: true });
}

async function coverHandler(request: FastifyRequest, reply: FastifyReply): Promise<void> {
  const key = (request.params as { "*": string })["*"];
  try {
    const absolutePath = thumbnailAbsolutePath(key);
    const data = await fsp.readFile(absolutePath);
    reply.type(COVER_MIME[path.extname(key).toLowerCase()] ?? "application/octet-stream")
      .header("Cache-Control", "private, max-age=3600")
      .send(data);
  } catch {
    reply.code(404).type("text/plain").send("Cover not found");
  }
}

// ── Plugin ──────────────────────────────────────────────────────────────────

export async function opdsPlugin(app: FastifyInstance) {
  // Every route is reachable two ways: /opds/<suffix> (Basic auth) and
  // /opds/:token/<suffix> (token in path). Static segments win over :token in the
  // router, so literal sub-paths ("all", "recent", …) never shadow a real token.
  const mount = (suffix: string, handler: (request: FastifyRequest, reply: FastifyReply) => unknown) => {
    app.get(`/opds${suffix}`, OPDS_ROUTE_OPTS, handler);
    app.get(`/opds/:token${suffix}`, OPDS_ROUTE_OPTS, handler);
  };

  mount("", rootNav);
  mount("/all", acquisitionHandler({ base: "/all", title: "All ebooks", id: "urn:isputnik:ebooks:all", sort: "title" }));
  mount("/recent", acquisitionHandler({ base: "/recent", title: "Recently added", id: "urn:isputnik:ebooks:recent", sort: "recent" }));
  mount("/search", acquisitionHandler({ base: "/search", title: "Search results", id: "urn:isputnik:ebooks:search", sort: "title" }));
  mount("/authors", facetNavHandler({ base: "/authors", title: "By author", id: "urn:isputnik:ebooks:authors", facetKey: "authors", param: "author" }));
  mount("/categories", facetNavHandler({ base: "/categories", title: "By category", id: "urn:isputnik:ebooks:categories", facetKey: "categories", param: "category" }));
  mount("/languages", facetNavHandler({ base: "/languages", title: "By language", id: "urn:isputnik:ebooks:languages", facetKey: "languages", param: "language" }));
  mount("/opensearch.xml", opensearchHandler);
  mount("/document/:itemId/:docId", documentHandler);
  mount("/cover/*", coverHandler);
}
