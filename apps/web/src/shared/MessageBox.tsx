import React from "react";
import { AlertTriangle, CheckCircle2, Info, XCircle } from "lucide-react";

export function MessageBox({
  tone,
  title,
  className,
  children
}: {
  tone: "info" | "warning" | "error" | "success";
  title: string;
  className?: string;
  children: React.ReactNode;
}) {
  const Icon = {
    info: Info,
    warning: AlertTriangle,
    error: XCircle,
    success: CheckCircle2
  }[tone];

  const classes = ["message-box", tone, className].filter(Boolean).join(" ");

  return (
    <div className={classes} role={tone === "error" ? "alert" : "status"}>
      <Icon size={18} aria-hidden="true" />
      <div>
        <strong>{title}</strong>
        <p>{children}</p>
      </div>
    </div>
  );
}
