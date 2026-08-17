import { z } from "zod";
import type { FastifyInstance } from "fastify";
import { db, logActivity } from "../db.js";
import { parseBody } from "./shared.js";
import { MAIL_SETTINGS_KEY, getMailSettings, isMailConfigured, sendTestEmail, type MailSettings } from "./mail.js";
import { sealSecret } from "./mfa.js";

const mailSchema = z.object({
  host: z.string().trim().max(255),
  port: z.number().int().min(1).max(65535),
  secure: z.boolean(),
  username: z.string().trim().max(255),
  // Omitted/blank on save = keep the stored password; never echoed back to the client.
  password: z.string().max(1024).optional(),
  fromAddress: z.union([z.literal(""), z.string().trim().email().max(254)]),
  fromName: z.string().trim().max(120)
});

// Strip the secret before it leaves the server; report only whether one is stored.
//
// Built field by field rather than by spreading everything-but-password: the blob
// on disk can hold keys this version no longer knows about — userNotifications
// lived here before it moved to notification_settings — and a spread would serve
// them back to the browser as though they still meant something.
function publicMail(settings: MailSettings) {
  return {
    host: settings.host,
    port: settings.port,
    secure: settings.secure,
    username: settings.username,
    fromAddress: settings.fromAddress,
    fromName: settings.fromName,
    hasPassword: Boolean(settings.password)
  };
}

export async function mailPlugin(app: FastifyInstance) {
  app.get("/api/config/mail", { preHandler: app.requireAdmin }, async () => ({
    mail: publicMail(getMailSettings()),
    configured: isMailConfigured()
  }));

  app.put("/api/config/mail", { preHandler: app.requireAdmin }, async (request, reply) => {
    const parsed = parseBody(mailSchema, request.body);
    if (parsed.error) {
      return reply.code(400).send({ error: "Invalid email settings", details: parsed.error });
    }

    const current = getMailSettings();
    const next: MailSettings = {
      host: parsed.data.host,
      port: parsed.data.port,
      secure: parsed.data.secure,
      username: parsed.data.username,
      password: parsed.data.password ? parsed.data.password : current.password,
      fromAddress: parsed.data.fromAddress,
      fromName: parsed.data.fromName
    };

    // Seal the password before it lands in the DB (and therefore in every backup
    // zip); getMailSettings un-seals it on read. hasPassword semantics are
    // unchanged — publicMail below still sees the plaintext `next`.
    const stored = { ...next, password: sealSecret(next.password) };
    db.prepare(`
      INSERT INTO app_settings (key, value, updated_by, updated_at)
      VALUES (?, ?, ?, strftime('%Y-%m-%dT%H:%M:%fZ','now'))
      ON CONFLICT(key) DO UPDATE SET
        value = excluded.value,
        updated_by = excluded.updated_by,
        updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
    `).run(MAIL_SETTINGS_KEY, JSON.stringify(stored), request.user!.id);

    logActivity({
      event: "config.mail_updated",
      actorUserId: request.user!.id,
      targetType: "setting",
      targetId: MAIL_SETTINGS_KEY,
      detail: `Updated email settings (host ${next.host || "—"}, from ${next.fromAddress || "—"}).`,
      ipAddress: request.ip
    });

    return reply.send({ mail: publicMail(next), configured: isMailConfigured(next) });
  });

  // Sends a test message to the admin's own account email, proving the SMTP path.
  app.post("/api/config/mail/test", { preHandler: app.requireAdmin }, async (request, reply) => {
    if (!isMailConfigured()) {
      return reply.code(400).send({ error: "Configure and save email settings first." });
    }
    try {
      await sendTestEmail(request.user!.email);
    } catch (err) {
      return reply.code(502).send({ error: err instanceof Error ? err.message : "Unable to send test email." });
    }
    logActivity({
      event: "config.mail_test",
      actorUserId: request.user!.id,
      targetType: "setting",
      targetId: MAIL_SETTINGS_KEY,
      detail: `Sent a test email to ${request.user!.email}.`,
      ipAddress: request.ip
    });
    return reply.send({ ok: true });
  });
}
