// Stub — this app only opens EPUB through foliate-js. See VENDOR.md.
export const isMOBI = () => false;
export class MOBI {
  open() {
    throw new Error("foliate-js: MOBI support is stubbed out in this build");
  }
}
