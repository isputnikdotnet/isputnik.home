// The English resource barrel — one import per namespace file. English is the
// fallback language, so all of it ships in the main bundle; other languages
// mirror this file list (see ru/index.ts) and load on demand.
//
// Adding a namespace: create <ns>.json here AND in every other language folder,
// then add it to both barrels. check:ui fails if the folders drift.
import common from "./common.json";
import library from "./library.json";
import book from "./book.json";
import reader from "./reader.json";
import gallery from "./gallery.json";
import galleryModals from "./galleryModals.json";
import family from "./family.json";
import user from "./user.json";
import stories from "./stories.json";
import misc from "./misc.json";
import control from "./control.json";
import controlAdmin from "./controlAdmin.json";
import controlDash from "./controlDash.json";

const resources = {
  common,
  library,
  book,
  reader,
  gallery,
  galleryModals,
  family,
  user,
  stories,
  misc,
  control,
  controlAdmin,
  controlDash
};

export default resources;
