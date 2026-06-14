const SENSITIVE_PATTERNS: RegExp[] = [
  /\b(sk-[A-Za-z0-9_-]{16,})\b/g,
  /\b(Bearer\s+)[A-Za-z0-9._~+/-]{16,}=*/gi,
  /\b(api[_-]?key|access[_-]?token|auth[_-]?token|password|secret)\b(\s*[:=]\s*)["']?([^\s"',;]{8,})/gi,
  /\b(AWS_SECRET_ACCESS_KEY|ANTHROPIC_API_KEY|OPENAI_API_KEY|GEMINI_API_KEY)(\s*=\s*)([^\s]+)/g
];

export function redactSensitiveText(value: string): string {
  return SENSITIVE_PATTERNS.reduce((text, pattern) =>
    text.replace(pattern, (match, prefix: string, separator?: string) => {
      if (/^Bearer\s+/i.test(match)) return `${prefix}[REDACTED]`;
      if (separator !== undefined) return `${prefix}${separator}[REDACTED]`;
      return "[REDACTED]";
    }), value);
}
