import { db } from "../../../db.js";

export interface LibraryAccessRow {
  id: string;
  owner_id: string | null;
  owner_type: "user" | "group" | null;
  visibility: "private" | "public";
  type: string;
}

export function canUserAccessLibrary(
  library: { owner_id: string | null; owner_type: string | null; visibility: string },
  userId: string,
  userRole: string
): boolean {
  if (userRole === "admin") return true;
  if (library.owner_type === "user" && library.owner_id === userId) return true;
  if (library.owner_type === "group" && library.owner_id) {
    const member = db.prepare("SELECT 1 FROM group_members WHERE group_id = ? AND user_id = ?")
      .get(library.owner_id, userId);
    if (member) return true;
  }
  if (library.visibility === "public") return true;
  return false;
}

export function canUserWriteLibrary(
  library: { owner_id: string | null; owner_type: string | null },
  userId: string,
  userRole: string
): boolean {
  if (userRole === "admin") return true;
  if (library.owner_type === "user" && library.owner_id === userId) return true;
  if (library.owner_type === "group" && library.owner_id) {
    const member = db.prepare("SELECT role FROM group_members WHERE group_id = ? AND user_id = ?")
      .get(library.owner_id, userId) as { role: string } | undefined;
    if (member?.role === "manager") return true;
  }
  return false;
}

export function getAccessibleLibrary(
  id: string,
  userId: string,
  userRole: string,
  type?: string
): LibraryAccessRow | null {
  const typeClause = type ? "AND type = ?" : "";
  const params = type ? [id, type] : [id];
  const library = db.prepare(`
    SELECT id, owner_id, owner_type, visibility, type
    FROM libraries
    WHERE id = ? ${typeClause}
  `).get(...params) as LibraryAccessRow | undefined;

  if (!library) return null;
  if (!canUserAccessLibrary(library, userId, userRole)) return null;
  return library;
}

export function getLibraryForBook(bookId: string): LibraryAccessRow | null {
  return db.prepare(`
    SELECT libraries.id, libraries.owner_id, libraries.owner_type, libraries.visibility, libraries.type
    FROM books
    JOIN libraries ON libraries.id = books.library_id
    WHERE books.id = ? AND books.deleted_at IS NULL
  `).get(bookId) as LibraryAccessRow | null;
}
