import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { db } from "../../db.js";
import { parseBody, parseQuery } from "../../core/shared.js";
import { configureScheduledJob, listScheduledJobs, runScheduledJob } from "./scheduler.js";
import { listTasks, withNewTaskIds } from "./tasks-view.js";
import type { JobRow } from "../../db/rows.js";

const configSchema = z.object({
  enabled: z.boolean(),
  frequency: z.enum(["daily", "weekly", "monthly"]),
  time: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/).optional(),
  dayOfWeek: z.number().int().min(0).max(6).optional(),
  dayOfMonth: z.number().int().min(1).max(28).optional()
});

// Page numbers stay strings: junk or an empty value falls back to the default
// below, as it always has, rather than failing the request.
const jobsQuerySchema = z.object({
  page: z.string().optional(),
  pageSize: z.string().optional(),
  status: z.string().optional(),
  type: z.string().optional(),
  library: z.string().optional()
});

// Comma-separated task ids.
const jobStatusQuerySchema = z.object({ ids: z.string().optional() });

export function registerMaintenanceRoutes(app: FastifyInstance) {
  app.get("/api/jobs", { preHandler: app.requireAdmin }, async (request, reply) => {
    const parsed = parseQuery(jobsQuerySchema, request.query);
    if (parsed.error) {
      return reply.code(400).send({ error: "Invalid query", details: parsed.error });
    }
    const query = parsed.data;
    const page = Math.max(1, Number.parseInt(query.page ?? "1", 10) || 1);
    const pageSize = Math.min(100, Math.max(1, Number.parseInt(query.pageSize ?? "25", 10) || 25));
    return listTasks(page, pageSize, {
      status: query.status?.trim() || undefined,
      type: query.type?.trim() || undefined,
      libraryId: query.library?.trim() || undefined
    });
  });

  app.post("/api/jobs/:id/cancel", { preHandler: app.requireAdmin }, async (request, reply) => {
    const id = (request.params as { id: string }).id;
    const job = db.prepare("SELECT id, type, status, payload FROM jobs WHERE id = ?").get(id) as Pick<JobRow, "id" | "type" | "status" | "payload"> | undefined;
    if (!job) {
      return reply.code(404).send({ error: "Task not found" });
    }
    if (job.status !== "pending" && job.status !== "running") {
      return reply.code(409).send({ error: "Task is not active" });
    }
    db.prepare(`
      UPDATE jobs
      SET status = 'failed', failed_at = strftime('%Y-%m-%dT%H:%M:%fZ','now'), locked_at = NULL, locked_by = NULL, error = 'Cancelled by user'
      WHERE id = ?
    `).run(id);
    try {
      const p = JSON.parse(job.payload) as { libraryId?: string; slideshowId?: string };
      if (p.libraryId) {
        db.prepare("UPDATE libraries SET scan_status = 'error', updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ? AND scan_status = 'scanning'")
          .run(p.libraryId);
      }
      // A cancelled slideshow render must release the slideshow from its 'rendering'
      // state now, or the editor polls "Rendering movie…" forever. Restore the previous
      // movie ('ready') if one is on disk, else back to the 'Render movie' CTA ('draft').
      // The render worker also sees the cancel (job no longer 'running') and stops.
      if (job.type === "gallery-slideshow-render" && p.slideshowId) {
        db.prepare(`
          UPDATE gallery_slideshows
          SET render_status = CASE WHEN output_storage_key IS NOT NULL THEN 'ready' ELSE 'draft' END,
              render_error = NULL
          WHERE id = ? AND render_status IN ('queued', 'rendering')
        `).run(p.slideshowId);
      }
    } catch { /* ignore */ }
    return reply.send({ cancelled: true });
  });

  app.get("/api/scheduled-jobs", { preHandler: app.requireAdmin }, async () => {
    return { jobs: listScheduledJobs() };
  });

  app.patch("/api/scheduled-jobs/:key", { preHandler: app.requireAdmin }, async (request, reply) => {
    const key = (request.params as { key: string }).key;
    const parsed = parseBody(configSchema, request.body);
    if (parsed.error) {
      return reply.code(400).send({ error: "Invalid scheduled job settings", details: parsed.error });
    }
    const { enabled, ...schedule } = parsed.data;
    const job = configureScheduledJob(key, enabled, schedule, request.user!.id, request.ip);
    if (!job) {
      return reply.code(404).send({ error: "Unknown scheduled job" });
    }
    return reply.send({ job });
  });

  app.post("/api/scheduled-jobs/:key/run", { preHandler: app.requireAdmin }, async (request, reply) => {
    const key = (request.params as { key: string }).key;
    const { result: job, taskIds } = withNewTaskIds(() => runScheduledJob(key, request.user!.id, "manual"));
    if (!job) {
      return reply.code(404).send({ error: "Unknown scheduled job" });
    }
    if (job.lastStatus === "error") {
      return reply.code(500).send({ error: job.lastMessage ?? "Job failed", job, taskIds });
    }
    return reply.send({ job, taskIds });
  });

  // Just the statuses of named tasks — what the Scheduled jobs page polls while a
  // manual run's work drains, rather than pulling the whole paged task list.
  app.get("/api/jobs/status", { preHandler: app.requireAdmin }, async (request, reply) => {
    const parsed = parseQuery(jobStatusQuerySchema, request.query);
    if (parsed.error) {
      return reply.code(400).send({ error: "Invalid query", details: parsed.error });
    }
    const raw = (parsed.data.ids ?? "").split(",").map((id) => id.trim()).filter(Boolean);
    const ids = raw.slice(0, 100);
    if (ids.length === 0) return { tasks: [] };
    const rows = db.prepare(
      `SELECT id, status FROM jobs WHERE id IN (${ids.map(() => "?").join(",")})`
    ).all(...ids) as Pick<JobRow, "id" | "status">[];
    return { tasks: rows };
  });
}
