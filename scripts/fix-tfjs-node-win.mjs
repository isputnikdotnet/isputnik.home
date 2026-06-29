// Windows-only postinstall fix for @tensorflow/tfjs-node.
//
// The published tfjs-node package can land its compiled binding (tfjs_binding.node)
// in lib/napi-v8/ while the matching tensorflow.dll lands in lib/napi-v10/ — so the
// binding can't find its DLL and `require('@tensorflow/tfjs-node')` fails with
// "The specified module could not be found." This copies the DLL next to the binding.
//
// No-op on non-Windows (Linux/macOS use a .so/.dylib whose layout is already correct),
// and harmless if the DLL is already in place. Best-effort: never fails the install.
import { existsSync, copyFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";

if (process.platform !== "win32") process.exit(0);

try {
  const libDir = path.resolve("node_modules/@tensorflow/tfjs-node/lib");
  if (!existsSync(libDir)) process.exit(0);

  const dirs = readdirSync(libDir).map((d) => path.join(libDir, d)).filter((p) => statSync(p).isDirectory());
  const bindingDir = dirs.find((p) => existsSync(path.join(p, "tfjs_binding.node")));
  const dllSource = dirs.map((p) => path.join(p, "tensorflow.dll")).find((p) => existsSync(p));

  if (!bindingDir || !dllSource) process.exit(0);
  const dest = path.join(bindingDir, "tensorflow.dll");
  if (!existsSync(dest)) {
    copyFileSync(dllSource, dest);
    console.log("fix-tfjs-node-win: copied tensorflow.dll next to tfjs_binding.node");
  }
} catch (err) {
  console.warn("fix-tfjs-node-win: skipped —", err instanceof Error ? err.message : err);
}
