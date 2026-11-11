// "Email me when it's ready" for a film being prepared for download
// (docs/video-quality-plan.md → Prepared copies). The engine makes the copies and
// never calls out, so this server looks in on it: once a minute while anyone is
// waiting, and not at all otherwise. One email per request, however many
// episodes it was for, sent once every one of them is ready (or will not be).
//
// The in-app Downloads page is how a copy is picked up; this is the nudge to come
// back for it, and only for someone who asked and has an address, on a server
// whose email is set up.
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import { config } from "../../../config.js";
import { renderEmail, type EmailBlock } from "../../../core/email-template.js";
import { isMailConfigured, sendMail } from "../../../core/mail.js";
import { parseBody } from "../../../core/shared.js";
import { db } from "../../../db.js";
import type { EngineClient } from "./engine.js";

/** How often the engine is asked while someone waits. */
const LOOK_EVERY_MS = 60_000;
/** A request nobody has heard about after this long is dropped: the engine was
 *  restarted, the film removed, the copy cleared. */
const GIVE_UP_AFTER_H = 48;
/** The most titles one email lists by name. */
const NAMED = 12;

const noticeSchema = z.object({
  /** One per Download: the titles asked for together are told of together. */
  batch: z.string().regex(/^[A-Za-z0-9_-]{6,40}$/),
  items: z.array(z.object({
    id: z.string().regex(/^[A-Za-z0-9_-]{1,64}$/),
    quality: z.union([z.literal(1080), z.literal(720), z.literal(480)]),
    title: z.string().trim().min(1).max(200)
  })).min(1).max(200)
});

interface NoticeRow {
  user_id: string;
  batch: string;
  item_id: string;
  quality: number;
  title: string;
  state: "waiting" | "ready" | "failed" | "skipped";
  created_at: string;
}

/** A title the engine never made a copy of (it was small enough to come as it
 *  is) is known by now: it no longer holds the email back. */
const NO_COPY_AFTER_MIN = 15;

interface EngineCopies {
  copies: { itemId: string; quality: number; state: string }[];
}

const emailOf = (userId: string) =>
  (db.prepare("SELECT email FROM users WHERE id = ? AND is_active = 1 AND deleted_at IS NULL").get(userId) as { email: string | null } | undefined)?.email ?? null;

/** Looks in on the engine and tells whoever's whole request is settled. Exported for the tests. */
export async function settleCopyNotices(engine: EngineClient, log: { warn: (obj: object, msg: string) => void }): Promise<void> {
  db.prepare("DELETE FROM video_copy_notices WHERE created_at < strftime('%Y-%m-%dT%H:%M:%fZ', 'now', ?)").run(`-${GIVE_UP_AFTER_H} hours`);
  const waiting = db.prepare("SELECT * FROM video_copy_notices WHERE state = 'waiting'").all() as NoticeRow[];
  if (waiting.length > 0) {
    let made: EngineCopies;
    try {
      made = await engine.call<EngineCopies>("GET", "/admin/copies");
    } catch {
      // The engine is away: asked again in a minute.
      return;
    }
    const states = new Map(made.copies.map((copy) => [`${copy.itemId}:${copy.quality}`, copy.state]));
    const mark = db.prepare("UPDATE video_copy_notices SET state = ? WHERE user_id = ? AND batch = ? AND item_id = ? AND quality = ?");
    for (const row of waiting) {
      const state = states.get(`${row.item_id}:${row.quality}`);
      if (state === "ready" || state === "failed") mark.run(state, row.user_id, row.batch, row.item_id, row.quality);
      else if (state === undefined && Date.now() - Date.parse(row.created_at) > NO_COPY_AFTER_MIN * 60_000) mark.run("skipped", row.user_id, row.batch, row.item_id, row.quality);
    }
  }
  // Every request with nothing left waiting: one email, then it is forgotten.
  const settled = db.prepare(`
    SELECT user_id, batch FROM video_copy_notices GROUP BY user_id, batch
    HAVING SUM(CASE WHEN state = 'waiting' THEN 1 ELSE 0 END) = 0
  `).all() as { user_id: string; batch: string }[];
  for (const { user_id: userId, batch } of settled) {
    const rows = db.prepare("SELECT * FROM video_copy_notices WHERE user_id = ? AND batch = ? ORDER BY rowid").all(userId, batch) as NoticeRow[];
    db.prepare("DELETE FROM video_copy_notices WHERE user_id = ? AND batch = ?").run(userId, batch);
    const to = emailOf(userId);
    const ready = rows.filter((row) => row.state === "ready");
    if (!to || ready.length === 0 || !isMailConfigured()) continue;
    const failed = rows.filter((row) => row.state === "failed").length;
    const names = ready.slice(0, NAMED).map((row) => row.title);
    const blocks: EmailBlock[] = [
      { kind: "text", text: ready.length === 1 ? "The copy you asked for is ready to download:" : `The ${ready.length} copies you asked for are ready to download:` },
      { kind: "subject", text: names.join("\n") + (ready.length > NAMED ? `\n… and ${ready.length - NAMED} more` : "") },
      { kind: "text", text: "Open Downloads in iSputnik on the device you want them on. They start downloading by themselves, and play there with no connection afterwards." },
      { kind: "button", label: "Open Downloads", url: `${config.appUrl.replace(/\/$/, "")}/downloads` },
      ...(failed > 0 ? [{ kind: "note" as const, text: `${failed} could not be prepared. Downloads says which; try them again from there.` }] : [])
    ];
    const { html, text } = renderEmail({ title: ready.length === 1 ? "Ready to download" : `${ready.length} ready to download`, blocks });
    const subject = ready.length === 1 ? `Ready to download: ${names[0].slice(0, 90)}` : `${ready.length} videos are ready to download`;
    // A broken relay must not stop the others being told.
    await sendMail({ to, subject, text, html }).catch((err: unknown) => log.warn({ err, userId }, "A ready-to-download email could not be sent"));
  }
}

export function registerCopyNotices(
  app: FastifyInstance,
  engine: EngineClient,
  gate: (request: FastifyRequest, reply: FastifyReply) => FastifyReply | null
): void {
  // Whether the tick box is worth showing to this person at all.
  app.get("/api/video/copy-notices", { preHandler: app.authenticate }, async (request, reply) => {
    const refused = gate(request, reply);
    if (refused) return refused;
    return { available: isMailConfigured() && Boolean(emailOf(request.user!.id)) };
  });

  app.post("/api/video/copy-notices", { preHandler: app.authenticate }, async (request, reply) => {
    const refused = gate(request, reply);
    if (refused) return refused;
    const parsed = parseBody(noticeSchema, request.body);
    if (parsed.error) return reply.code(400).send({ error: "Invalid request", details: parsed.error });
    const body = parsed.data;
    const userId = request.user!.id;
    if (!isMailConfigured() || !emailOf(userId)) return reply.code(409).send({ error: "Email is not set up for this account.", code: "video.notice_no_email" });
    const insert = db.prepare(`
      INSERT INTO video_copy_notices (user_id, batch, item_id, quality, title) VALUES (?, ?, ?, ?, ?)
      ON CONFLICT (user_id, batch, item_id, quality) DO NOTHING
    `);
    db.transaction(() => {
      for (const item of body.items) insert.run(userId, body.batch, item.id, item.quality, item.title);
    })();
    return reply.code(204).send();
  });

  const timer = setInterval(() => {
    // Nobody waiting: nothing is asked of the engine.
    const any = db.prepare("SELECT 1 FROM video_copy_notices LIMIT 1").get();
    if (any) void settleCopyNotices(engine, app.log).catch((err: unknown) => app.log.warn({ err }, "Looking in on copies to download failed"));
  }, LOOK_EVERY_MS);
  timer.unref();
  app.addHook("onClose", async () => clearInterval(timer));
}
