import type { FastifyInstance, FastifyReply } from "fastify";

// RFC 9116 security.txt, served as a route rather than a file in the web root for
// one reason: Expires is mandatory and absolute, so a checked-in file would ship a
// fixed date that goes stale on every self-hosted install and then reads as an
// abandoned contact. Computing it per request keeps every installation valid
// without anyone maintaining it.
//
// Without this route the SPA fallback answered /.well-known/security.txt with
// index.html — a scanner then sees a "security.txt" whose media type is text/html
// and reports it as malformed rather than absent.
//
// The contact is the upstream project, not the operator: a vulnerability found in
// somebody's family library is a vulnerability in this software, and the person
// running it usually can't fix it. Reports belong where the code is.
const CONTACT = "https://github.com/isputnikdotnet/isputnik.home/security/advisories/new";
const EXPIRY_DAYS = 180;

export async function securityTxtPlugin(app: FastifyInstance) {
  const send = (reply: FastifyReply) => {
    const expires = new Date(Date.now() + EXPIRY_DAYS * 24 * 60 * 60 * 1000).toISOString();
    // Seconds precision: RFC 9116 wants an ISO 8601 timestamp, and the fractional
    // milliseconds Date gives by default are legal but trip some strict parsers.
    const body = [
      `Contact: ${CONTACT}`,
      `Expires: ${expires.replace(/\.\d{3}Z$/, "Z")}`,
      "Preferred-Languages: en",
      "",
      "# isputnik.home is self-hosted: this address reaches the people who maintain",
      "# the software, not the household running this particular copy.",
      ""
    ].join("\n");
    return reply.type("text/plain; charset=utf-8").send(body);
  };

  app.get("/.well-known/security.txt", async (_request, reply) => send(reply));
  // The legacy top-level location is still probed by scanners and some tooling.
  app.get("/security.txt", async (_request, reply) => send(reply));
}
