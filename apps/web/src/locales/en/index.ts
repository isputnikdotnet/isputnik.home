// The English resource barrel — one import per namespace file. English is the
// fallback language, so it ships in the main bundle; other languages mirror
// this file list (see ru/index.ts) and load on demand. The control panel's
// three namespaces are not here: they ship in control-panel.ts, loaded when a
// component first asks for one of them (i18n.ts), so nobody downloads them on
// the way to Home or the sign-in page.
//
// Adding a namespace: create <ns>.json here AND in every other language folder,
// then add it to both barrels (or both control-panel.ts files, for a namespace
// only the control panel uses). check:ui fails if the folders drift.
import common from "./common.json";
import book from "./book.json";
import reader from "./reader.json";
import gallery from "./gallery.json";
import galleryModals from "./galleryModals.json";
import galleryReview from "./galleryReview.json";
import family from "./family.json";
import user from "./user.json";
import stories from "./stories.json";
import misc from "./misc.json";

const resources = {
  common,
  book,
  reader,
  gallery,
  galleryModals,
  galleryReview,
  family,
  user,
  stories,
  misc
};

export default resources;
