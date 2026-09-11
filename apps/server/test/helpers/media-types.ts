// Register every media type into the shared layer's registry, as their plugins
// do at boot (library/shared/media-types.ts). Import this for its side effect in
// a suite that exercises cross-type behaviour — restoring from the bin, scan
// rules, the maintenance schedule, a folder move — without registering the
// plugins themselves (which would also start their workers):
//
//   import "./helpers/media-types.js";
import { registerAudiobookMediaType } from "../../src/modules/library/audiobook/media-type.js";
import { registerEbookMediaType } from "../../src/modules/library/ebook/media-type.js";
import { registerGalleryMediaType } from "../../src/modules/library/gallery/media-type.js";

registerAudiobookMediaType();
registerEbookMediaType();
registerGalleryMediaType();
