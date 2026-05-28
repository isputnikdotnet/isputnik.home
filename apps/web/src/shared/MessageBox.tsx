import React from "react";
import { AlertTriangle, CheckCircle2, Info, XCircle } from "lucide-react";

export function MessageBox({
  tone,
  title,
  children
}: {
  tone: "info" | "warning" | "error" | "success";
  title: string;
  children: React.ReactNode;
}) {
  const Icon = {
    info: Info,
    warning: AlertTriangle,
    error: XCircle,
    success: CheckCircle2
  }[tone];

  return (
    <div className={`message-box ${tone}`} role={tone === "error" ? "alert" : "status"}>
      <Icon size={18} aria-hidden="true" />
      <div>
        <strong>{title}</strong>
        <p>{children}</p>
      </div>
    </div>
  );
}
