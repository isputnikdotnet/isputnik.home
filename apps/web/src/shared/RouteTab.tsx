import type React from "react";
import { moveAlongTablist } from "./tablist";

// A tab that is a real address (the control panel's rows, a member's tabs, Profile):
// a link, so it can be bookmarked and Ctrl/Cmd-clicked into a new tab, wearing tab
// semantics and the arrow-key walk that shared/Button gives button tabs. Put it in
// an element with role="tablist".
export function RouteTab({
  href,
  selected,
  onClick,
  className,
  children,
  ...rest
}: {
  href: string;
  selected: boolean;
  /** The router's follow (followRoute, followReplace…): plain clicks stay in the app. */
  onClick: (event: React.MouseEvent<HTMLAnchorElement>, href: string) => void;
  className?: string;
  children: React.ReactNode;
} & Pick<React.AnchorHTMLAttributes<HTMLAnchorElement>, "id" | "aria-controls">) {
  return (
    <a
      {...rest}
      role="tab"
      aria-selected={selected}
      className={className}
      href={href}
      onClick={(event) => onClick(event, href)}
      onKeyDown={moveAlongTablist}
    >
      {children}
    </a>
  );
}
