import { z } from "zod";
import type { FastifyInstance } from "fastify";
import { nanoid } from "nanoid";
import { db } from "../../db.js";
import { parseBody } from "../../core/shared.js";
import { COLLECTABLE_ENTITY_TYPES, hydrateEntities, type HydratedEntity } from "./hydrators.js";

const createSchema = z.object({
  name: z.string().trim().min(1).max(120),
  description: z.string().trim().max(2000).nullable().optional()
});

const updateSchema = z.object({
  name: z.string().trim().min(1).max(120).optional(),
  description: z.string().trim().max(2000).nullable().optional()
});

const addItemSchema = z.object({
  entityType: z.enum(COLLECTABLE_ENTITY_TYPES as [string, ...string[]]),
  entityId: z.string().trim().min(1).max(64)
});

const reorderSchema = z.object({
  orderedItemIds: z.array(z.string().trim().min(1).max(64)).min(1)
});

interface CollectionRow {
  id: string;
  name: string;
  description: string | null;
  created_at: string;
  updated_at: string;
}

interface ItemRow {
  id: string;
  entity_type: string;
  entity_id: string;
  position: number;
  added_at: string;
}

function ownedCollection(id: string, userId: string): CollectionRow | undefined {
  return db.prepare(
    "SELECT id, name, description, created_at, updated_at FROM collections WHERE id = ? AND user_id = ?"
  ).get(id, userId) as CollectionRow | undefined;
}

function itemView(row: ItemRow, hydrated: Map<string, HydratedEntity>) {
  const view = hydrated.get(`${row.entity_type}:${row.entity_id}`);
  return {
    id: row.id,
    entityType: row.entity_type,
    entityId: row.entity_id,
    position: row.position,
    addedAt: row.added_at,
    available: view?.available ?? false,
    title: view?.title ?? "Unavailable item",
    subtitle: view?.subtitle ?? null,
    coverUrl: view?.coverUrl ?? null,
    durationSeconds: view?.durationSeconds ?? null,
    fileCount: view?.fileCount ?? 0,
    href: view?.href ?? "",
    playable: view?.playable ?? false
  };
}

export async function collectionsPlugin(app: FastifyInstance) {
  // List the caller's collections. Pass ?entityType=&entityId= to also learn
  // which collections already contain that item (drives the add-to dialog).
  app.get("/api/collections", { preHandler: app.authenticate }, async (request, reply) => {
    const user = request.user!;
    const query = request.query as { entityType?: string; entityId?: string };

    const collections = db.prepare(
      "SELECT id, name, description, created_at, updated_at FROM collections WHERE user_id = ? ORDER BY datetime(updated_at) DESC"
    ).all(user.id) as CollectionRow[];

    const items = collections.length === 0 ? [] : db.prepare(`
      SELECT id, collection_id, entity_type, entity_id, position
      FROM collection_items
      WHERE collection_id IN (${collections.map(() => "?").join(", ")})
      ORDER BY position ASC
    `).all(...collections.map((c) => c.id)) as (ItemRow & { collection_id: string })[];

    const hydrated = hydrateEntities(
      items.map((item) => ({ entityType: item.entity_type, entityId: item.entity_id })),
      user
    );

    const byCollection = new Map<string, (ItemRow & { collection_id: string })[]>();
    for (const item of items) {
      const list = byCollection.get(item.collection_id) ?? [];
      list.push(item);
      byCollection.set(item.collection_id, list);
    }

    reply.send({
      collections: collections.map((collection) => {
        const members = byCollection.get(collection.id) ?? [];
        const coverUrls = members
          .map((m) => hydrated.get(`${m.entity_type}:${m.entity_id}`)?.coverUrl)
          .filter((url): url is string => Boolean(url))
          .slice(0, 4);
        const match = query.entityType && query.entityId
          ? members.find((m) => m.entity_type === query.entityType && m.entity_id === query.entityId)
          : undefined;
        return {
          id: collection.id,
          name: collection.name,
          description: collection.description,
          itemCount: members.length,
          coverUrls,
          createdAt: collection.created_at,
          updatedAt: collection.updated_at,
          containsItem: query.entityType && query.entityId ? Boolean(match) : undefined,
          itemId: match?.id
        };
      })
    });
  });

  app.post("/api/collections", { preHandler: app.authenticate }, async (request, reply) => {
    const user = request.user!;
    const parsed = parseBody(createSchema, request.body);
    if (parsed.error) {
      reply.code(400).send({ error: "Invalid collection", details: parsed.error });
      return;
    }
    const id = nanoid(16);
    db.prepare("INSERT INTO collections (id, user_id, name, description) VALUES (?, ?, ?, ?)")
      .run(id, user.id, parsed.data.name, parsed.data.description ?? null);
    const collection = ownedCollection(id, user.id)!;
    reply.code(201).send({
      collection: {
        id: collection.id,
        name: collection.name,
        description: collection.description,
        itemCount: 0,
        coverUrls: [],
        createdAt: collection.created_at,
        updatedAt: collection.updated_at
      }
    });
  });

  // Full collection with its ordered, hydrated items.
  app.get("/api/collections/:id", { preHandler: app.authenticate }, async (request, reply) => {
    const user = request.user!;
    const id = (request.params as { id: string }).id;
    const collection = ownedCollection(id, user.id);
    if (!collection) {
      reply.code(404).send({ error: "Collection not found" });
      return;
    }
    const items = db.prepare(
      "SELECT id, entity_type, entity_id, position, added_at FROM collection_items WHERE collection_id = ? ORDER BY position ASC"
    ).all(id) as ItemRow[];
    const hydrated = hydrateEntities(
      items.map((item) => ({ entityType: item.entity_type, entityId: item.entity_id })),
      user
    );
    reply.send({
      collection: {
        id: collection.id,
        name: collection.name,
        description: collection.description,
        createdAt: collection.created_at,
        updatedAt: collection.updated_at,
        items: items.map((item) => itemView(item, hydrated))
      }
    });
  });

  app.patch("/api/collections/:id", { preHandler: app.authenticate }, async (request, reply) => {
    const user = request.user!;
    const id = (request.params as { id: string }).id;
    const collection = ownedCollection(id, user.id);
    if (!collection) {
      reply.code(404).send({ error: "Collection not found" });
      return;
    }
    const parsed = parseBody(updateSchema, request.body);
    if (parsed.error) {
      reply.code(400).send({ error: "Invalid collection", details: parsed.error });
      return;
    }
    db.prepare(`
      UPDATE collections SET
        name = COALESCE(?, name),
        description = CASE WHEN ? THEN ? ELSE description END,
        updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
      WHERE id = ?
    `).run(
      parsed.data.name ?? null,
      parsed.data.description !== undefined ? 1 : 0,
      parsed.data.description ?? null,
      id
    );
    const updated = ownedCollection(id, user.id)!;
    reply.send({
      collection: {
        id: updated.id,
        name: updated.name,
        description: updated.description,
        createdAt: updated.created_at,
        updatedAt: updated.updated_at
      }
    });
  });

  app.delete("/api/collections/:id", { preHandler: app.authenticate }, async (request, reply) => {
    const user = request.user!;
    const id = (request.params as { id: string }).id;
    const collection = ownedCollection(id, user.id);
    if (!collection) {
      reply.code(404).send({ error: "Collection not found" });
      return;
    }
    db.prepare("DELETE FROM collections WHERE id = ?").run(id); // items cascade
    reply.send({ deleted: true });
  });

  // Append an item. Rejects entities the caller can't actually access, so a
  // collection can never become a backdoor to hidden content.
  app.post("/api/collections/:id/items", { preHandler: app.authenticate }, async (request, reply) => {
    const user = request.user!;
    const id = (request.params as { id: string }).id;
    const collection = ownedCollection(id, user.id);
    if (!collection) {
      reply.code(404).send({ error: "Collection not found" });
      return;
    }
    const parsed = parseBody(addItemSchema, request.body);
    if (parsed.error) {
      reply.code(400).send({ error: "Invalid item", details: parsed.error });
      return;
    }
    const { entityType, entityId } = parsed.data;

    const hydrated = hydrateEntities([{ entityType, entityId }], user);
    if (!hydrated.get(`${entityType}:${entityId}`)?.available) {
      reply.code(404).send({ error: "Item not found" });
      return;
    }

    const existing = db.prepare(
      "SELECT id FROM collection_items WHERE collection_id = ? AND entity_type = ? AND entity_id = ?"
    ).get(id, entityType, entityId) as { id: string } | undefined;

    if (!existing) {
      const next = db.prepare(
        "SELECT COALESCE(MAX(position), 0) + 1 AS pos FROM collection_items WHERE collection_id = ?"
      ).get(id) as { pos: number };
      db.transaction(() => {
        db.prepare(
          "INSERT INTO collection_items (id, collection_id, entity_type, entity_id, position) VALUES (?, ?, ?, ?, ?)"
        ).run(nanoid(16), id, entityType, entityId, next.pos);
        db.prepare("UPDATE collections SET updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ?").run(id);
      })();
    }

    reply.send({ added: true });
  });

  app.delete("/api/collections/:id/items/:itemId", { preHandler: app.authenticate }, async (request, reply) => {
    const user = request.user!;
    const { id, itemId } = request.params as { id: string; itemId: string };
    const collection = ownedCollection(id, user.id);
    if (!collection) {
      reply.code(404).send({ error: "Collection not found" });
      return;
    }
    db.transaction(() => {
      db.prepare("DELETE FROM collection_items WHERE id = ? AND collection_id = ?").run(itemId, id);
      db.prepare("UPDATE collections SET updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ?").run(id);
    })();
    reply.send({ removed: true });
  });

  // Persist a new order. Items not named keep their relative order after the
  // listed ones (defensive — the client always sends the full list).
  app.patch("/api/collections/:id/items/reorder", { preHandler: app.authenticate }, async (request, reply) => {
    const user = request.user!;
    const id = (request.params as { id: string }).id;
    const collection = ownedCollection(id, user.id);
    if (!collection) {
      reply.code(404).send({ error: "Collection not found" });
      return;
    }
    const parsed = parseBody(reorderSchema, request.body);
    if (parsed.error) {
      reply.code(400).send({ error: "Invalid order", details: parsed.error });
      return;
    }
    const owned = new Set(
      (db.prepare("SELECT id FROM collection_items WHERE collection_id = ?").all(id) as { id: string }[])
        .map((row) => row.id)
    );
    const setPosition = db.prepare("UPDATE collection_items SET position = ? WHERE id = ? AND collection_id = ?");
    db.transaction(() => {
      let pos = 1;
      for (const itemId of parsed.data.orderedItemIds) {
        if (owned.has(itemId)) setPosition.run(pos++, itemId, id);
      }
      db.prepare("UPDATE collections SET updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ?").run(id);
    })();
    reply.send({ reordered: true });
  });
}
