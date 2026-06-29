// The active face-embedding model id, stamped on every face row (gallery_faces
// .embedding_model). Kept in its own tiny module so the clustering layer can filter to
// the current model WITHOUT importing arcface.ts (which would eagerly load the native
// onnxruntime binding). When the model changes, this id changes and old-model faces are
// ignored by clustering until the library is rescanned.
export const FACE_EMBEDDING_MODEL = "buffalo_s/w600k_mbf";
