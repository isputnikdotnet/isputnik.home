// ffprobe-static ships no type definitions; it exports the resolved binary path.
declare module "ffprobe-static" {
  const ffprobe: { path: string; version?: string };
  export default ffprobe;
}
