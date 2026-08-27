import React from "react";
import { AlertTriangle, CheckCircle2, Info, XCircle } from "lucide-react";

export function MessageBox({
  tone,
  title,
  className,
  action,
  children
}: {
  tone: "info" | "warning" | "error" | "success";
  title: string;
  className?: string;
  /** Optional call to action (a Button or link) shown under the message —
      for notices whose fix is one click away, like "set up storage". */
  action?: React.ReactNode;
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
        <div className="message-box-body">{children}</div>
        {action && <div className="message-box-action">{action}</div>}
      </div>
    </div>
  );
}
