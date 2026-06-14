import type { ButtonHTMLAttributes, ReactNode } from "react";
import { cn } from "../utils/classnames";

export type ButtonVariant = "primary" | "secondary" | "subtle" | "danger" | "icon";
export type ButtonSize = "tool" | "default";

export function Button({
  children,
  className,
  icon,
  label,
  size,
  variant,
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & {
  icon?: ReactNode;
  label?: string;
  size?: ButtonSize;
  variant?: ButtonVariant;
}) {
  const accessibleLabel = props["aria-label"] ?? label;
  const resolvedSize = size ?? "tool";
  const resolvedVariant = variant ?? "secondary";
  return (
    <button
      {...props}
      aria-label={accessibleLabel}
      className={cn("ui-button", `ui-button-${resolvedVariant}`, `ui-button-${resolvedSize}`, className)}
      title={props.title ?? (resolvedVariant === "icon" ? accessibleLabel : undefined)}
    >
      {icon}
      {children}
    </button>
  );
}
