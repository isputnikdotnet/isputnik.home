import { useCallback, useEffect, useMemo, useState, type ReactElement } from "react";
import { useTranslation } from "react-i18next";
import { ChevronRight, Folder, Library, Lock, Info, X } from "lucide-react";
import { api } from "../../../api";
import { MessageBox } from "../../../shared/MessageBox";
import { foldersBase, type BrowseFolder, type FolderOwnership, type FoldersResponse, type LayoutLibrary } from "./types";

// Step 1: which folders the rule covers. A tree rooted at the library, loaded a
// level at a time; a tick covers the folder and everything inside it. Folders an
// enabled rule sits on exactly are locked (two rules may not share a folder);
// their children stay tickable and take over just that part.
interface Node extends BrowseFolder {
  children: Node[] | null; // null = not loaded yet
  loading: boolean;
}

export function FoldersStep({
  library,
  selected,
  editingRuleId,
  onChange
}: {
  library: LayoutLibrary;
  selected: string[];
  editingRuleId: string | null;
  onChange: (paths: string[]) => void;
}) {
  const { t } = useTranslation(["common", "controlAdmin"]);
  const noun = library.type === "audiobook" ? "audiobooks" : "books";
  const [root, setRoot] = useState<{ books: number; ownedBy: FolderOwnership | null; children: Node[] } | null>(null);
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set(selected.filter(Boolean)));
  const [error, setError] = useState("");
  const [query, setQuery] = useState("");

  const load = useCallback(async (path: string): Promise<FoldersResponse> =>
    api<FoldersResponse>(`${foldersBase(library.id)}?path=${encodeURIComponent(path)}`), [library.id]);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const payload = await load("");
        if (cancelled) return;
        setRoot({ books: payload.totalBooks, ownedBy: payload.ownedBy, children: payload.folders.map((f) => ({ ...f, children: null, loading: false })) });
        // Open the folders an existing rule already covers, so they are visible.
        for (const path of selected.filter(Boolean)) {
          const parents = path.split("/").slice(0, -1);
          for (let i = 1; i <= parents.length; i++) setExpanded((prev) => new Set(prev).add(parents.slice(0, i).join("/")));
        }
      } catch (err) {
        if (!cancelled) setError(err instanceof Error ? err.message : t("controlAdmin:layout.browseFailed"));
      }
    })();
    return () => { cancelled = true; };
  }, [load, t]); // eslint-disable-line react-hooks/exhaustive-deps

  const updateNode = (path: string, patch: (node: Node) => Node) => {
    setRoot((current) => {
      if (!current) return current;
      const walk = (nodes: Node[]): Node[] => nodes.map((n) => n.relativePath === path ? patch(n) : (n.children ? { ...n, children: walk(n.children) } : n));
      return { ...current, children: walk(current.children) };
    });
  };

  const findNode = (path: string): Node | null => {
    const walk = (nodes: Node[]): Node | null => {
      for (const n of nodes) {
        if (n.relativePath === path) return n;
        if (n.children) { const hit = walk(n.children); if (hit) return hit; }
      }
      return null;
    };
    return root ? walk(root.children) : null;
  };

  const toggleExpand = async (node: Node) => {
    const open = expanded.has(node.relativePath);
    if (open) { setExpanded((prev) => { const next = new Set(prev); next.delete(node.relativePath); return next; }); return; }
    setExpanded((prev) => new Set(prev).add(node.relativePath));
    if (node.children === null && !node.loading) {
      updateNode(node.relativePath, (n) => ({ ...n, loading: true }));
      try {
        const payload = await load(node.relativePath);
        updateNode(node.relativePath, (n) => ({ ...n, loading: false, children: payload.folders.map((f) => ({ ...f, children: null, loading: false })) }));
      } catch (err) {
        updateNode(node.relativePath, (n) => ({ ...n, loading: false, children: [] }));
        setError(err instanceof Error ? err.message : t("controlAdmin:layout.browseFailed"));
      }
    }
  };

  // Load the children of folders an existing rule covers, once the tree is up.
  useEffect(() => {
    if (!root) return;
    for (const path of expanded) {
      const node = findNode(path);
      if (node && node.children === null && !node.loading) void toggleExpand({ ...node });
    }
  }, [root, expanded]); // eslint-disable-line react-hooks/exhaustive-deps

  const coveredBy = (path: string): string | null => {
    let best: string | null = null;
    for (const s of selected) {
      if (s === path || s === "" || path.startsWith(`${s}/`)) if (best === null || s.length > best.length) best = s;
    }
    return best;
  };

  const pick = (path: string, on: boolean) => {
    if (on) {
      // A folder covers its descendants, so ticked ones inside it are redundant.
      const kept = selected.filter((s) => !(path === "" ? s !== "" : s.startsWith(`${path}/`)));
      onChange([...kept, path]);
      if (path) setExpanded((prev) => new Set(prev).add(path));
    } else {
      onChange(selected.filter((s) => s !== path));
    }
  };

  // Ownership, seen from the rule being edited: its own folders are not "another rule".
  const otherOwner = (owner: FolderOwnership | null): FolderOwnership | null =>
    owner && owner.ruleId !== editingRuleId ? owner : null;

  const matchesQuery = (node: Node): boolean => {
    if (!query) return true;
    const q = query.toLowerCase();
    return node.relativePath.toLowerCase().includes(q) || (node.children ?? []).some(matchesQuery);
  };

  const renderNode = (node: Node, depth: number): ReactElement | null => {
    if (!matchesQuery(node)) return null;
    const owner = otherOwner(node.ownedBy);
    const lockedSame = Boolean(owner && owner.exact && owner.enabled);
    const insideEnabled = Boolean(owner && owner.enabled && !owner.exact);
    const isSel = selected.includes(node.relativePath);
    const cover = coveredBy(node.relativePath);
    const inherited = !isSel && cover !== null;
    const open = expanded.has(node.relativePath) || (query.length > 0);
    const ruleShort = owner ? owner.name : "";
    let badge: ReactElement | null = null;
    if (lockedSame) badge = <span className="layout-badge is-rule" title={t("controlAdmin:layout.ownedByTitle", { name: owner!.name })}><Lock size={11} aria-hidden="true" /> {ruleShort}</span>;
    else if (owner && owner.exact && !owner.enabled) badge = <span className="layout-badge is-rule-off">{t("controlAdmin:layout.ownedDisabled", { name: ruleShort })}</span>;
    else if (isSel && insideEnabled) badge = <span className="layout-badge is-takeover">{t("controlAdmin:layout.takesOver", { name: ruleShort })}</span>;
    else if (inherited) badge = <span className="layout-badge is-included">{t("controlAdmin:layout.included")}</span>;
    return (
      <li key={node.relativePath} role="treeitem" aria-expanded={open} aria-selected={isSel}>
        <div className={`layout-tree-row ${isSel ? "is-selected" : ""} ${inherited ? "is-inherited" : ""} ${lockedSame ? "is-owned" : ""}`} style={{ paddingLeft: 12 + depth * 22 }}>
          <button type="button" className={`layout-twisty ${open ? "is-open" : ""}`} aria-label={t(open ? "controlAdmin:layout.collapse" : "controlAdmin:layout.expand", { name: node.name })} onClick={() => toggleExpand(node)}>
            <ChevronRight size={14} aria-hidden="true" />
          </button>
          <input
            type="checkbox"
            checked={isSel}
            disabled={inherited || lockedSame}
            title={lockedSame ? t("controlAdmin:layout.ownedByTitle", { name: owner!.name }) : inherited ? t("controlAdmin:layout.includedTitle", { parent: cover || t("controlAdmin:layout.wholeLibrary") }) : undefined}
            aria-label={t("controlAdmin:layout.coverFolder", { name: node.name })}
            onChange={(event) => pick(node.relativePath, event.target.checked)}
          />
          <span className="layout-tree-name"><Folder size={16} aria-hidden="true" /><span className="layout-tree-text">{node.name}</span></span>
          <span className="layout-tree-meta">{noun === "audiobooks" ? t("controlAdmin:layout.audiobooks", { count: node.books }) : t("controlAdmin:layout.books", { count: node.books })}</span>
          <span className="layout-tree-badge">{badge}</span>
        </div>
        {open && node.children && node.children.length > 0 && (
          <ul role="group">{node.children.map((child) => renderNode(child, depth + 1))}</ul>
        )}
        {open && node.loading && <div className="layout-tree-hint" style={{ paddingLeft: 12 + (depth + 1) * 22 }}>{t("controlAdmin:ui.loading")}</div>}
        {open && node.children && node.children.length === 0 && !node.loading && <div className="layout-tree-hint" style={{ paddingLeft: 12 + (depth + 1) * 22 }}>{t("controlAdmin:layout.noSubfolders")}</div>}
      </li>
    );
  };

  const rootSel = selected.includes("");
  // Another rule already anchored at the root: the whole library cannot be taken again.
  const rootOwner = root ? otherOwner(root.ownedBy) : null;
  const rootLocked = Boolean(rootOwner && rootOwner.exact);
  const picks = [...selected].sort();
  const counts = useMemo(() => {
    const map = new Map<string, number>();
    const walk = (nodes: Node[]) => { for (const n of nodes) { map.set(n.relativePath, n.books); if (n.children) walk(n.children); } };
    if (root) walk(root.children);
    return map;
  }, [root]);
  const coveredBooks = rootSel ? (root?.books ?? 0) : picks.reduce((n, p) => n + (counts.get(p) ?? 0), 0);

  // Notes about ownership the selection affects.
  const notes: { tone: "info" | "take" | "def"; text: string }[] = [];
  if (rootSel) notes.push({ tone: "def", text: t("controlAdmin:layout.noteDefault") });
  for (const p of picks) {
    const node = findNode(p);
    const owner = node ? otherOwner(node.ownedBy) : null;
    if (owner && owner.enabled && !owner.exact) notes.push({ tone: "take", text: t("controlAdmin:layout.noteTakeover", { folder: p, rule: owner.name }) });
  }

  return (
    <div className="layout-folders">
      <p className="layout-intro">{t("controlAdmin:layout.foldersIntro")}</p>
      {error && <MessageBox tone="error" title={t("controlAdmin:layout.errorTitle")}>{error}</MessageBox>}
      <div className="layout-toolbar">
        <input className="layout-search" type="search" value={query} placeholder={t("controlAdmin:layout.findFolder")} aria-label={t("controlAdmin:layout.findFolder")} onChange={(event) => setQuery(event.target.value.trim())} />
        <span className="layout-spacer" />
        <span className="layout-legend"><span className="layout-legend-swatch is-covered" aria-hidden="true" />{t("controlAdmin:layout.legendCovered")}</span>
        <span className="layout-legend"><span className="layout-legend-swatch is-owned" aria-hidden="true" />{t("controlAdmin:layout.legendOwned")}</span>
      </div>

      <div className="layout-tree" role="tree">
        <div className={`layout-tree-row is-root ${rootSel ? "is-selected" : ""}`} style={{ paddingLeft: 12 }}>
          <span className="layout-twisty is-open is-static" aria-hidden="true"><ChevronRight size={14} /></span>
          <input type="checkbox" checked={rootSel} disabled={rootLocked} title={rootLocked ? t("controlAdmin:layout.ownedByTitle", { name: rootOwner!.name }) : undefined} aria-label={t("controlAdmin:layout.coverWholeLibrary")} onChange={(event) => pick("", event.target.checked)} />
          <span className="layout-tree-name"><Library size={16} aria-hidden="true" /><span className="layout-tree-text is-root">{t("controlAdmin:layout.wholeLibrary")}</span></span>
          <span className="layout-tree-meta">{root ? (noun === "audiobooks" ? t("controlAdmin:layout.audiobooks", { count: root.books }) : t("controlAdmin:layout.books", { count: root.books })) : ""}</span>
          <span className="layout-tree-badge">
            {rootSel && <span className="layout-badge is-default">{t("controlAdmin:layout.becomesDefault")}</span>}
            {rootLocked && <span className="layout-badge is-rule" title={t("controlAdmin:layout.ownedByTitle", { name: rootOwner!.name })}><Lock size={11} aria-hidden="true" /> {rootOwner!.name}</span>}
          </span>
        </div>
        {root ? (
          <ul role="group">{root.children.map((node) => renderNode(node, 1))}</ul>
        ) : (
          <div className="layout-tree-hint" style={{ paddingLeft: 34 }}>{t("controlAdmin:ui.loading")}</div>
        )}
      </div>

      {picks.length === 0 ? (
        <div className="layout-selection is-empty">{t("controlAdmin:layout.nothingChosen")}</div>
      ) : (
        <div className="layout-selection">
          <div className="layout-selection-head">
            <strong>{rootSel ? t("controlAdmin:layout.wholeLibrary") : t("controlAdmin:layout.selectionCount", { count: picks.length })}</strong>
            <span className="muted">{noun === "audiobooks" ? t("controlAdmin:layout.selectionAudiobooks", { count: coveredBooks }) : t("controlAdmin:layout.selectionBooks", { count: coveredBooks })}</span>
          </div>
          <div className="layout-chips">
            {picks.map((p) => (
              <span key={p} className="layout-folder-chip">
                {p === "" ? t("controlAdmin:layout.wholeLibrary") : p}
                <span className="layout-folder-chip-n">{p === "" ? root?.books ?? 0 : counts.get(p) ?? 0}</span>
                <button type="button" className="layout-folder-chip-x" aria-label={t("controlAdmin:layout.remove", { path: p || t("controlAdmin:layout.wholeLibrary") })} onClick={() => pick(p, false)}><X size={13} /></button>
              </span>
            ))}
          </div>
          {notes.length > 0 && (
            <div className="layout-notes">
              {notes.map((note, i) => <div key={i} className={`layout-note is-${note.tone}`}><Info size={15} aria-hidden="true" /><span>{note.text}</span></div>)}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
