import { usePreferencesStore } from "../stores/preferences.store";
import { useResolvedTheme } from "../hooks/useResolvedTheme";
import { cn } from "../utils/classnames";

type BrandLogoVariant = "auto" | "dark" | "light";
export function BrandLogo({
  className,
  label,
  variant
}: {
  className?: string;
  label?: string;
  variant?: BrandLogoVariant;
}) {
  const theme = usePreferencesStore((state) => state.theme);
  const resolvedTheme = useResolvedTheme(theme);
  const resolvedVariant = variant ?? "auto";
  const lightSurface = resolvedVariant === "light" || (resolvedVariant === "auto" && resolvedTheme === "light");
  const logoUrl = lightSurface
    ? "./flowweave_black_line_on_white.png"
    : "./flowweave_white_on_black.png";
  return <img alt={label ?? "FlowWeave"} className={cn("brand-logo", className)} src={logoUrl} />;
}
