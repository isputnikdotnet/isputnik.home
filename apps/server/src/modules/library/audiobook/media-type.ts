// What the shared library layer may ask of audiobooks — registered into the
// media-type registry from audiobookPlugin, so trash, scan rules and the
// maintenance schedule never import this type's scanner. See
// library/shared/media-types.ts.
import { registerMediaType } from "../shared/media-types.js";
import { enqueueLibraryScans } from "../shared/scan-lock.js";
import { discNumberFromFolderName } from "./scan/folder-parse.js";
import {
  enqueueAudiobookScan,
  previewAudiobookRulePattern,
  processAudiobookScanQueue,
  rescanSingleBook
} from "./scanner.js";

export function registerAudiobookMediaType(): void {
  registerMediaType({
    type: "audiobook",
    enqueueScan: (libraryId, options) => enqueueAudiobookScan(libraryId, options),
    processQueue: processAudiobookScanQueue,
    // An audiobook re-catalogues its own single folder, which is cheap and is not
    // a library-wide walk — so a restored book comes back that way.
    rescanItem: (itemId) => rescanSingleBook(itemId),
    previewRulePattern: (libraryId, folders, layouts, ruleId) => previewAudiobookRulePattern(libraryId, folders, layouts, ruleId),
    isDiscFolder: (folderName) => discNumberFromFolderName(folderName) !== null,
    scheduledJobs: [
      {
        key: "scan_audiobook_libraries",
        label: "Scan audiobook libraries",
        description: "Look for new, changed, or removed audiobook files in every audiobook library and update the catalog.",
        category: "audiobooks",
        defaultEnabled: true,
        defaultFrequency: "daily",
        defaultTime: "02:00",
        randomizeDefaultTime: true,
        run: () => enqueueLibraryScans("audiobook", "audiobook", enqueueAudiobookScan)
      }
    ]
  });
}
