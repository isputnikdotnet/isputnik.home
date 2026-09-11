import type { ReactElement } from "react";
import { render } from "@testing-library/react";
import type { PublicUser } from "../../src/api";
import { SessionContext, type Session } from "../../src/app/SessionContext";

// A signed-in page reads who is signed in from SessionContext (App provides it),
// not from props — so a test that mounts one on its own provides it here.
export function renderSignedIn(
  ui: ReactElement,
  { user = { id: "u1", role: "user" } as unknown as PublicUser, isAdminSession = false, logout = async () => {} }: Partial<Session> = {}
) {
  return render(
    <SessionContext.Provider value={{ user, logout, isAdminSession }}>{ui}</SessionContext.Provider>
  );
}
