// The server "right now" (Diagnostics › a part's page, the Right now card): how busy
// the CPU is and how much memory is free. Read only when the page asks — every few
// seconds while it is open — and nothing is kept but the last CPU reading, which the
// next one is measured against. Home and its containers share one machine, so these
// are the machine's numbers for every part's page; inside Docker /proc shows the
// host's, which is what's wanted.
import fs from "node:fs";
import os from "node:os";

export interface ServerNow {
  at: string;
  cpu: {
    /** Share of all cores busy since the last reading (or over a short sample), 0–100. */
    percent: number;
    cores: number;
    /** 1, 5 and 15-minute load averages; null where the system has none (Windows). */
    load: [number, number, number] | null;
  };
  memory: {
    totalBytes: number;
    /** What can be used without swapping: MemAvailable on Linux, free memory elsewhere. */
    availableBytes: number;
    /** This server's own process. */
    homeBytes: number;
  };
}

interface CpuTimes { busy: number; total: number; at: number }

function cpuTimes(): CpuTimes {
  let busy = 0;
  let total = 0;
  for (const cpu of os.cpus()) {
    const { user, nice, sys, irq, idle } = cpu.times;
    busy += user + nice + sys + irq;
    total += user + nice + sys + irq + idle;
  }
  return { busy, total, at: Date.now() };
}

const percentBetween = (a: CpuTimes, b: CpuTimes): number => {
  const total = b.total - a.total;
  return total > 0 ? Math.max(0, Math.min(100, Math.round(((b.busy - a.busy) / total) * 1000) / 10)) : 0;
};

/** MemAvailable from /proc/meminfo; null where there is none. */
export function memAvailable(meminfo?: string): number | null {
  let text = meminfo;
  if (text === undefined) {
    try {
      text = fs.readFileSync("/proc/meminfo", "utf8");
    } catch {
      return null;
    }
  }
  const kb = text.match(/^MemAvailable:\s+(\d+)\s+kB/m)?.[1];
  return kb ? Number(kb) * 1024 : null;
}

let last: CpuTimes | null = null;
/** A reading older than this is too stale to measure against: sample afresh. */
const STALE_MS = 60_000;
const SAMPLE_MS = 250;

export async function serverNow(): Promise<ServerNow> {
  let before = last;
  if (!before || Date.now() - before.at > STALE_MS) {
    before = cpuTimes();
    await new Promise((resolve) => setTimeout(resolve, SAMPLE_MS));
  }
  const now = cpuTimes();
  last = now;
  const load = process.platform === "win32" ? null : (os.loadavg().map((value) => Math.round(value * 100) / 100) as [number, number, number]);
  return {
    at: new Date(now.at).toISOString(),
    cpu: { percent: percentBetween(before, now), cores: os.cpus().length, load },
    memory: { totalBytes: os.totalmem(), availableBytes: memAvailable() ?? os.freemem(), homeBytes: process.memoryUsage().rss }
  };
}
