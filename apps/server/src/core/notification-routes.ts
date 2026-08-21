import { z } from "zod";
import type { FastifyInstance } from "fastify";
import { logActivity } from "../db.js";
import { parseBody } from "./shared.js";
import { isMailConfigured } from "./mail.js";
import {
  NOTIFICATION_SETTINGS_KEY,
  getNotificationSettings,
  setNotificationSettings,
  type NotificationSettings
} from "./notifications.js";

const notificationSchema = z.object({
  shareNotifications: z.boolean(),
  recommendationNotifications: z.boolean()
});

export async function notificationsPlugin(app: FastifyInstance) {
  // mailConfigured rides along on both replies: the page greys itself out
  // without it, and asking for it separately would let the two disagree.
  app.get("/api/config/notifications", { preHandler: app.requireAdmin }, async () => ({
    notifications: getNotificationSettings(),
    mailConfigured: isMailConfigured()
  }));

  app.put("/api/config/notifications", { preHandler: app.requireAdmin }, async (request, reply) => {
    const parsed = parseBody(notificationSchema, request.body);
    if (parsed.error) {
      return reply.code(400).send({ error: "Invalid notification settings", details: parsed.error });
    }

    // Refused rather than quietly stored. A flag that is on while nothing can be
    // delivered is a promise the server can't keep, and it would start mailing
    // the moment someone unrelated configured SMTP months later.
    if ((parsed.data.shareNotifications || parsed.data.recommendationNotifications) && !isMailConfigured()) {
      return reply.code(400).send({ error: "Set up an email server first — there is nowhere to send notifications." });
    }

    const next: NotificationSettings = {
      shareNotifications: parsed.data.shareNotifications,
      recommendationNotifications: parsed.data.recommendationNotifications
    };
    setNotificationSettings(next, request.user!.id);

    logActivity({
      event: "config.notifications_updated",
      actorUserId: request.user!.id,
      targetType: "setting",
      targetId: NOTIFICATION_SETTINGS_KEY,
      detail: `Share notifications ${next.shareNotifications ? "on" : "off"}, send-to notifications ${next.recommendationNotifications ? "on" : "off"}.`,
      ipAddress: request.ip
    });

    return reply.send({ notifications: next, mailConfigured: isMailConfigured() });
  });
}
