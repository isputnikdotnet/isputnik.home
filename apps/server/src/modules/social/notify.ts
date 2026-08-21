// Tells someone, by email, that a family member sent them something.
//
// Follows share-notify.ts exactly, for the same reasons: fire-and-forget (a
// broken relay can never fail the send that triggered it), gated on an admin
// toggle that is OFF by default and on SMTP being configured at all, and it
// carries no files — only a nudge to open the app.
//
// The in-app inbox is the primary channel. Most installs never configure SMTP,
// so anything that only mails is invisible; this is the extra, not the delivery.
import { db } from "../../db.js";
import { sendMail } from "../../core/mail.js";
import { renderEmail, type EmailBlock } from "../../core/email-template.js";
import { recommendationNotificationsEnabled } from "../../core/notifications.js";

const FOOTER = "— Automated notification from your iSputnik server.";

// Subject lines carry the title because that is what makes mail scannable in a
// list; cap it so a 300-character audiobook title doesn't run the header off.
function clip(value: string, max = 90): string {
  return value.length > max ? `${value.slice(0, max - 1).trimEnd()}…` : value;
}

interface Recipient {
  email: string | null;
  display_name: string;
}

function loadRecipient(userId: string): Recipient | null {
  return (db.prepare(`
    SELECT email, display_name FROM users
    WHERE id = ? AND is_active = 1 AND deleted_at IS NULL
  `).get(userId) as Recipient | undefined) ?? null;
}

export function notifyRecommendationSent(opts: {
  recipientId: string;
  senderName: string;
  subjectTitle: string;
  /** The sender's one line, if they wrote one. */
  message: string | null;
  /** Origin of the page the sender was on, so the link lands on the same host. */
  origin: string;
}): void {
  if (!recommendationNotificationsEnabled()) return;
  const recipient = loadRecipient(opts.recipientId);
  if (!recipient?.email) return;

  const subject = `${opts.senderName} sent you "${clip(opts.subjectTitle)}"`;
  const lead = `${opts.senderName} thought you'd like this.`;

  const blocks: EmailBlock[] = [
    { kind: "text", text: `Hello ${recipient.display_name},` },
    { kind: "text", text: lead },
    { kind: "subject", text: opts.subjectTitle }
  ];
  if (opts.message) blocks.push({ kind: "text", text: `"${opts.message}"` });
  blocks.push({ kind: "button", label: "Open it", url: `${opts.origin}/shared` });
  blocks.push({
    kind: "note",
    text: "Nothing was sent with this message — it points at something already on your family server, and signing in to your own account is what opens it."
  });

  void (async () => {
    try {
      const { html, text } = renderEmail({ title: subject, preheader: lead, blocks, footnote: FOOTER });
      await sendMail({ to: recipient.email as string, subject, text, html });
    } catch {
      // Best-effort: the send must succeed whether or not the mail goes out.
    }
  })();
}
