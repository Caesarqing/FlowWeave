import { useEffect, useState } from "react";
import type { UiThemeId } from "../types";

export function useResolvedTheme(theme: UiThemeId): "light" | "dark" {
  const [systemTheme, setSystemTheme] = useState<"light" | "dark">(() =>
    window.matchMedia("(prefers-color-scheme: light)").matches ? "light" : "dark"
  );
  useEffect(() => {
    const media = window.matchMedia("(prefers-color-scheme: light)");
    function updateTheme() {
      setSystemTheme(media.matches ? "light" : "dark");
    }
    media.addEventListener("change", updateTheme);
    return () => media.removeEventListener("change", updateTheme);
  }, []);
  return theme === "light" || (theme === "system" && systemTheme === "light") ? "light" : "dark";
}
