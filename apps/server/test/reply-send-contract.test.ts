import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

// Fastify requires an async handler that calls reply.send() to hand the reply
// back — `return reply.send(...)`, not a bare call. Otherwise the handler's
// promise resolves to undefined while the send is still in flight, and any
// ASYNCHRONOUS onSend hook then either truncates the response to an empty body
// or throws ERR_HTTP_HEADERS_SENT and takes the process down.
//
// This codebase had 878 handlers written the bare way. They were harmless only
// because nothing here registers an async onSend hook (core/compression.ts is
// deliberately synchronous for exactly this reason). That is a tripwire, not a
// design, so the call sites were fixed — and this test keeps them fixed, because
// the failure is silent and a reviewer will not spot a missing `return`.

const srcRoot = fileURLToPath(new URL("../src", import.meta.url));

function tsFiles(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) return tsFiles(p);
    return e.name.endsWith(".ts") ? [p] : [];
  });
}

/** Unwrap reply.code(400).type(x).send(...) down to the root identifier. */
function rootOf(expr: ts.Expression): ts.Expression {
  let e: ts.Expression = expr;
  for (;;) {
    if (ts.isCallExpression(e)) { e = e.expression; continue; }
    if (ts.isPropertyAccessExpression(e)) { e = e.expression; continue; }
    return e;
  }
}

function bareSends(file: string): string[] {
  const src = ts.createSourceFile(file, fs.readFileSync(file, "utf8"), ts.ScriptTarget.ES2022, true);
  const found: string[] = [];

  const checkFn = (fn: ts.FunctionLikeDeclarationBase) => {
    if (!fn.body || !ts.isBlock(fn.body)) return;
    const isAsync = fn.modifiers?.some((m) => m.kind === ts.SyntaxKind.AsyncKeyword);
    if (!isAsync) return;
    if (!fn.parameters.some((p) => ts.isIdentifier(p.name) && p.name.text === "reply")) return;

    const walk = (node: ts.Node) => {
      // a nested function has its own return contract
      if (node !== fn && (ts.isFunctionDeclaration(node) || ts.isFunctionExpression(node) || ts.isArrowFunction(node))) return;
      if (ts.isExpressionStatement(node) && ts.isCallExpression(node.expression)) {
        const call = node.expression;
        if (ts.isPropertyAccessExpression(call.expression) && call.expression.name.text === "send") {
          const root = rootOf(call.expression);
          if (ts.isIdentifier(root) && root.text === "reply") {
            const line = src.getLineAndCharacterOfPosition(node.getStart()).line + 1;
            found.push(`${path.relative(srcRoot, file).replace(/\\/g, "/")}:${line}  ${node.getText().split("\n")[0].trim().slice(0, 70)}`);
          }
        }
      }
      ts.forEachChild(node, walk);
    };
    ts.forEachChild(fn.body, walk);
  };

  const scan = (node: ts.Node) => {
    if (ts.isArrowFunction(node) || ts.isFunctionExpression(node) || ts.isFunctionDeclaration(node)) {
      checkFn(node as ts.FunctionLikeDeclarationBase);
    }
    ts.forEachChild(node, scan);
  };
  scan(src);
  return found;
}

describe("async handlers return their reply", () => {
  it("has no bare reply.send() inside an async handler", () => {
    const offenders = tsFiles(srcRoot).flatMap(bareSends);
    expect(offenders, `Use \`return reply.send(...)\`. Bare sends found:\n  ${offenders.join("\n  ")}`).toEqual([]);
  });

  it("still finds one when it is there, so the check cannot rot into a no-op", () => {
    const tmp = path.join(srcRoot, "__bare_send_probe.ts");
    fs.writeFileSync(tmp, [
      'import type { FastifyInstance } from "fastify";',
      "export function probe(app: FastifyInstance) {",
      '  app.get("/x", async (request, reply) => { reply.code(200).send({ ok: true }); });',
      "}"
    ].join("\n"));
    try {
      expect(bareSends(tmp)).toHaveLength(1);
    } finally {
      fs.unlinkSync(tmp);
    }
  });
});
