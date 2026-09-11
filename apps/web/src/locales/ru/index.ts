// The Russian resource barrel. Mirrors en/index.ts file for file; loaded as one
// dynamic import (a single chunk) when the language switches to Russian.
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
import control from "./control.json";
import controlAdmin from "./controlAdmin.json";
import controlDash from "./controlDash.json";

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
  misc,
  control,
  controlAdmin,
  controlDash
};

export default resources;
