import type { ChangedFile, SafetyLevel, SafetyWarning } from "../../types";

const BLOCKED_PATH_PATTERN = /(^|[\\/])(\.env($|\.)|credentials\.[^\\/]+$)|\.(key|pem|p12|pfx|crt|cer)$/i;

export function checkSafety(files: ChangedFile[]): { level: SafetyLevel; warnings: SafetyWarning[] } {
  const warnings: SafetyWarning[] = [];

  for (const file of files) {
    if (BLOCKED_PATH_PATTERN.test(file.path)) {
      warnings.push({
        level: "blocked",
        code: "sensitive-file",
        filePath: file.path,
        message: `Sensitive file change requires manual review: ${file.path}`
      });
    }

    if (file.additions + file.deletions > 500) {
      warnings.push({
        level: "review",
        code: "large-file-change",
        filePath: file.path,
        message: `Large file change over 500 lines: ${file.path}`
      });
    }
  }

  const deletedCount = files.filter((file) => file.status === "deleted").length;
  if (deletedCount > 5) {
    warnings.push({
      level: "review",
      code: "many-deletions",
      message: `More than 5 deleted files detected: ${deletedCount}`
    });
  }

  return {
    level: warnings.some((warning) => warning.level === "blocked")
      ? "blocked"
      : warnings.some((warning) => warning.level === "review")
        ? "review"
        : "ok",
    warnings
  };
}
