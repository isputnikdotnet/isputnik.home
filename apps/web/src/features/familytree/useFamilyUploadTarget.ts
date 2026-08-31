import { useEffect, useState } from "react";
import { api } from "../../api";

// Where family-tree uploads land, and whether this viewer may put files there.
// An admin nominates the destination library once in the family tree's
// settings; no destination (or no permission) means the photo picker simply
// shows no Upload tab.
export interface FamilyUploadSettings {
  galleryLibrary: { id: string; name: string } | null;
  canUpload: boolean;
  isAdmin: boolean;
}

/** The nominated upload destination, or null while unknown / not allowed —
 *  shaped for PhotoPicker's `uploadTo` prop. */
export function useFamilyUploadTarget(): { id: string; name: string } | null {
  const [target, setTarget] = useState<{ id: string; name: string } | null>(null);
  useEffect(() => {
    api<FamilyUploadSettings>("/api/family-tree/settings")
      .then((settings) => {
        if (settings.canUpload && settings.galleryLibrary) setTarget(settings.galleryLibrary);
      })
      .catch(() => {}); // no settings, no Upload tab
  }, []);
  return target;
}
