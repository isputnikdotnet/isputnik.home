// What the shared library layer may ask of ebooks — registered into the
// media-type registry from ebookPlugin. See library/shared/media-types.ts.
import { registerMediaType } from "../shared/media-types.js";
import { enqueueLibraryScans } from "../shared/scan-lock.js";
import { enqueueEbookScan, previewEbookRulePattern, processEbookScanQueue } from "./scanner.js";

export function registerEbookMediaType(): void {
  registerMediaType({
    type: "ebook",
    enqueueScan: (libraryId, options) => enqueueEbookScan(libraryId, options),
    processQueue: processEbookScanQueue,
    previewRulePattern: (libraryId, folders, layouts, ruleId) => previewEbookRulePattern(libraryId, folders, layouts, ruleId),
    scheduledJobs: [
      {
        key: "scan_ebook_libraries",
        label: "Scan ebook libraries",
        description: "Look for new, changed, or removed book files in every ebook library and update the catalog.",
        category: "ebooks",
        defaultEnabled: true,
        defaultFrequency: "daily",
        defaultTime: "02:30",
        randomizeDefaultTime: true,
        run: () => enqueueLibraryScans("ebook", "ebook", enqueueEbookScan)
      }
    ]
  });
}
