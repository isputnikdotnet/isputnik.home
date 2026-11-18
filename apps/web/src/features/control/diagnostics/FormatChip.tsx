import type { ReactNode } from "react";
import { Check } from "lucide-react";

// A format or a step as a pill, the way Diagnostics › Video's Overview lists what
// the GPU plays: lit green with a tick where the GPU does it, filled where the CPU
// does, an outline where nothing is done to it (copied as it is), dim where it can't.

export type ChipTone = "gpu" | "cpu" | "copy" | "off";

export function FormatChip({ tone, label, title }: { tone: ChipTone; label: ReactNode; title: string }) {
  const className = tone === "gpu" ? "is-lit" : tone === "cpu" ? "is-cpu" : tone === "copy" ? "is-copy" : undefined;
  return (
    <li className={className} title={title} aria-label={`${typeof label === "string" ? label : ""}: ${title}`}>
      {tone === "gpu" && <Check size={12} aria-hidden="true" />}
      {label}
    </li>
  );
}
