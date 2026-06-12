import { Check } from "lucide-react";
import type { ReactNode } from "react";

// Circular progress indicator shared by the episode list (where it doubles as the
// played/reset toggle via onClick) and the player chapter list (display-only, with
// the chapter number in the centre). Fill = progress; full ring + check = complete.
export function ProgressRing({
  progress,
  complete = false,
  size = 26,
  strokeWidth = 2.5,
  center,
  onClick,
  label,
  className
}: {
  progress: number;
  complete?: boolean;
  size?: number;
  strokeWidth?: number;
  center?: ReactNode;
  onClick?: () => void;
  label?: string;
  className?: string;
}) {
  const radius = (size - strokeWidth) / 2;
  const mid = size / 2;
  const circumference = 2 * Math.PI * radius;
  const fraction = complete ? 1 : Math.max(0, Math.min(progress, 1));
  const dashoffset = circumference * (1 - fraction);

  const ring = (
    <span className={`progress-ring${complete ? " complete" : ""}${className ? ` ${className}` : ""}`} style={{ width: size, height: size }}>
      <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} aria-hidden="true">
        <circle className="progress-ring-track" cx={mid} cy={mid} r={radius} fill="none" strokeWidth={strokeWidth} />
        {fraction > 0 && (
          <circle
            className="progress-ring-arc"
            cx={mid}
            cy={mid}
            r={radius}
            fill="none"
            strokeWidth={strokeWidth}
            strokeLinecap="round"
            strokeDasharray={circumference}
            strokeDashoffset={dashoffset}
            transform={`rotate(-90 ${mid} ${mid})`}
          />
        )}
      </svg>
      <span className="progress-ring-center">
        {complete ? <Check size={Math.round(size * 0.46)} strokeWidth={3} /> : center}
      </span>
    </span>
  );

  if (!onClick) {
    return ring;
  }
  return (
    <button type="button" className="progress-ring-button" onClick={onClick} aria-label={label} title={label} aria-pressed={complete}>
      {ring}
    </button>
  );
}
