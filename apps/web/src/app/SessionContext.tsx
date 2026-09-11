import { createContext, useContext } from "react";
import type { PublicUser } from "../api";

// Who is signed in, and the way out — provided once by App for every signed-in
// route, so a page (and the shell around it) reads them here instead of having
// them handed down through every layer of props.
export interface Session {
  user: PublicUser;
  logout: () => Promise<void>;
  /** An admin on a full session — a linked display is refused on every admin
   *  route even for an admin account. See isAdminSession in api.ts. */
  isAdminSession: boolean;
}

export const SessionContext = createContext<Session | null>(null);

// For anything rendered only behind the sign-in gate. Throws rather than hand back
// a half-session: a signed-in page drawn with nobody signed in is a routing bug.
export function useSession(): Session {
  const session = useContext(SessionContext);
  if (!session) throw new Error("useSession() used outside a signed-in route");
  return session;
}
