import { useEffect, useState } from "react";
import { api } from "../../api";
import type { PhotoUploadTarget } from "../gallery/PhotoPicker";

// Where family-tree uploads land, and whether this viewer may put files there.
// The destination is the house's "App files" library (Control → Settings
// → Gallery) and its "Family tree" folder; no destination (or no permission)
// means the photo picker simply shows no Upload tab.
export interface FamilyUploadSettings {
  galleryLibrary: { id: string; name: string } | null;
  uploadFolder: string | null;
  canUpload: boolean;
  isAdmin: boolean;
}

/** The upload destination, or null while unknown / not allowed — shaped for
 *  PhotoPicker's `uploadTo` prop. */
export function useFamilyUploadTarget(): PhotoUploadTarget | null {
  const [target, setTarget] = useState<PhotoUploadTarget | null>(null);
  useEffect(() => {
    api<FamilyUploadSettings>("/api/family-tree/settings")
      .then((settings) => {
        if (settings.canUpload && settings.galleryLibrary) {
          setTarget({ ...settings.galleryLibrary, folder: settings.uploadFolder ?? undefined });
        }
      })
      .catch(() => {}); // no settings, no Upload tab
  }, []);
  return target;
}
