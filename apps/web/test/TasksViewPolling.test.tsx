import { act, render, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../src/api", () => ({ api: vi.fn() }));

const { api } = await import("../src/api");
const { TasksView } = await import("../src/features/control/sections/dashboard/TasksView");
const mockApi = vi.mocked(api);

// While something is running, the Tasks tab refreshes itself every 2.5 seconds.
// The list it polls for is rebuilt on every render, so keying the timer on the
// list itself tore it down and started it again whenever anything else on the
// page moved — and a page that re-renders faster than the interval never
// refreshes at all. This pins the timer to the one thing it should follow:
// whether any task is still pending or running.

const POLL_MS = 2500;

const runningTask = {
  id: "job-1",
  type: "SCAN_GALLERY_LIBRARY",
  status: "running" as const,
  attempts: 1,
  libraryName: "Photos",
  createdAt: "2026-09-11T10:00:00.000Z",
  startedAt: "2026-09-11T10:00:01.000Z",
  completedAt: null,
  failedAt: null,
  error: null,
  summary: null,
  progress: { processed: 3, total: 12, unit: "photos", etaSeconds: 60 },
  batch: null,
  stalledSeconds: null,
  bookErrors: []
};

function tasksPayload() {
  return {
    jobs: [runningTask],
    page: 1,
    total: 1,
    totalPages: 1,
    queue: { holder: runningTask, waiting: 0 },
    facets: { types: ["SCAN_GALLERY_LIBRARY"], libraries: [{ id: "lib-1", name: "Photos" }] },
    summary: { running: 1, queued: 0, failedWeek: 0, lastFinished: null }
  };
}

let taskCalls = 0;

beforeEach(() => {
  taskCalls = 0;
  mockApi.mockReset();
  mockApi.mockImplementation(async (path: string) => {
    if (path.startsWith("/api/scheduled-jobs")) return { jobs: [] };
    if (path.startsWith("/api/jobs")) {
      taskCalls += 1;
      return tasksPayload();
    }
    throw new Error(`Unexpected request: ${path}`);
  });
  vi.useFakeTimers({ shouldAdvanceTime: true });
});

afterEach(() => {
  vi.useRealTimers();
});

describe("tasks tab polling", () => {
  it("refreshes while a task is running", async () => {
    render(<TasksView />);
    await waitFor(() => expect(taskCalls).toBe(1));

    await act(async () => { await vi.advanceTimersByTimeAsync(POLL_MS + 100); });
    expect(taskCalls).toBeGreaterThan(1);
  });

  it("keeps the next refresh on schedule across an unrelated re-render", async () => {
    const { rerender } = render(<TasksView />);
    await waitFor(() => expect(taskCalls).toBe(1));

    // Most of the way through the interval, something else re-renders the page.
    await act(async () => { await vi.advanceTimersByTimeAsync(2000); });
    expect(taskCalls).toBe(1);
    rerender(<TasksView />);

    // The refresh still lands when it was due, rather than 2.5s after the render.
    await act(async () => { await vi.advanceTimersByTimeAsync(600); });
    expect(taskCalls).toBe(2);
  });

  it("stops polling once nothing is running", async () => {
    mockApi.mockImplementation(async (path: string) => {
      if (path.startsWith("/api/scheduled-jobs")) return { jobs: [] };
      if (path.startsWith("/api/jobs")) {
        taskCalls += 1;
        const payload = tasksPayload();
        return {
          ...payload,
          jobs: [{ ...runningTask, status: "completed" as const, completedAt: "2026-09-11T10:05:00.000Z", progress: null }],
          queue: { holder: null, waiting: 0 },
          summary: { running: 0, queued: 0, failedWeek: 0, lastFinished: null }
        };
      }
      throw new Error(`Unexpected request: ${path}`);
    });

    render(<TasksView />);
    await waitFor(() => expect(taskCalls).toBe(1));

    await act(async () => { await vi.advanceTimersByTimeAsync(POLL_MS * 3); });
    expect(taskCalls).toBe(1);
  });
});
