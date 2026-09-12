import { createContext, useContext } from "react";

// A guest on a share link has no session, so every map request on their page
// has to carry the link that lets them in. The page that knows the token
// provides it; MapView reads it and hands it to the renderer. Nothing else in
// the app needs to know maps care.
export const MapShareContext = createContext<string | null>(null);

export function useMapShare(): string | null {
  return useContext(MapShareContext);
}
