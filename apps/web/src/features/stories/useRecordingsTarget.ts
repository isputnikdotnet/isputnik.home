import { useEffect, useState } from "react";
import { api } from "../../api";

// Whether narration can be recorded at all: an admin nominates a gallery
// library as the recordings destination once (Control → Settings → Stories),
// and until then the story editor shows no Record/Upload — except to admins,
// who see the affordance disabled with a pointer at the setting.
export interface StoriesSettingsPayload {
  recordingsLibrary: { id: string; name: string } | null;
  /** Whether "From a link" is offered when starting a recipe. */
  recipeImportEnabled: boolean;
  isAdmin: boolean;
}

/** Whether a recipe may be started from a link. Unknown (not loaded yet, or
 *  the request failed) reads as no, so the field never flashes in and out. */
export function useRecipeImportEnabled(): boolean {
  const [enabled, setEnabled] = useState(false);
  useEffect(() => {
    api<StoriesSettingsPayload>("/api/stories/settings")
      .then((settings) => setEnabled(Boolean(settings.recipeImportEnabled)))
      .catch(() => {});
  }, []);
  return enabled;
}

export function useRecordingsTarget(): { enabled: boolean; isAdmin: boolean } {
  const [state, setState] = useState({ enabled: false, isAdmin: false });
  useEffect(() => {
    api<StoriesSettingsPayload>("/api/stories/settings")
      .then((settings) => setState({ enabled: Boolean(settings.recordingsLibrary), isAdmin: settings.isAdmin }))
      .catch(() => {}); // unknown → no narration affordance
  }, []);
  return state;
}
