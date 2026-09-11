import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { db, logActivity } from "../../db.js";
import { parseBody } from "../../core/shared.js";
import { getFamilyDefaultPerson, getFamilyUploadLibrary, setFamilyTreeSettings } from "./settings.js";
import { can, parsePolicy } from "../../core/permissions.js";
import type { LibraryRow } from "../../db/rows.js";

export function registerSettingsRoutes(app: FastifyInstance) {
  // ── Settings ──
  // Read is open: the photo picker needs to know where uploads go (and whether
  // the viewer may upload there at all) before it offers the option.
  app.get("/api/family-tree/settings", { preHandler: app.authenticate }, async (request) => {
    const user = request.user!;
    const library = getFamilyUploadLibrary();
    let canUpload = false;
    if (library) {
      const row = db.prepare("SELECT id, policy_json FROM libraries WHERE id = ?")
        .get(library.id) as Pick<LibraryRow, "id" | "policy_json"> | undefined;
      if (row) {
        canUpload = can(user, { objectType: "library", objectId: row.id, policy: parsePolicy(row.policy_json) }, "upload");
      }
    }
    return {
      // The house "App files" library and the folder uploads file under —
      // the picker sends the folder back with the upload.
      galleryLibrary: library ? { id: library.id, name: library.name } : null,
      uploadFolder: library?.folder ?? null,
      canUpload,
      defaultPerson: getFamilyDefaultPerson(),
      isAdmin: user.role === "admin"
    };
  });

  // The upload library is no longer set here (it is the house library, Control →
  // Library → Storage); `null` clears the starting person, omitting leaves it.
  const settingsSchema = z.object({
    defaultPersonId: z.string().trim().min(1).nullable().optional()
  });

  app.put("/api/family-tree/settings", { preHandler: app.requireAdmin }, async (request, reply) => {
    const parsed = parseBody(settingsSchema, request.body);
    if (parsed.error) {
      return reply.code(400).send({ error: "Invalid settings", details: parsed.error });
    }
    const { defaultPersonId } = parsed.data;
    if (defaultPersonId) {
      const exists = db.prepare("SELECT 1 FROM family_tree_persons WHERE id = ?").get(defaultPersonId);
      if (!exists) {
        return reply.code(404).send({ error: "Person not found" });
      }
    }

    setFamilyTreeSettings(parsed.data, request.user!.id);

    const details: string[] = [];
    if (defaultPersonId !== undefined) {
      details.push(
        defaultPersonId
          ? `Set the person the family tree opens on to ${getFamilyDefaultPerson()?.name ?? defaultPersonId}.`
          : "Cleared the person the family tree opens on."
      );
    }
    if (details.length > 0) {
      logActivity({
        event: "familytree.settings.updated",
        actorUserId: request.user!.id,
        targetType: "family_tree",
        detail: details.join(" "),
        ipAddress: request.ip
      });
    }
    return reply.send({ galleryLibrary: getFamilyUploadLibrary(), defaultPerson: getFamilyDefaultPerson() });
  });
}
