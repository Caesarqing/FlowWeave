import { describe, expect, it } from "vitest";
import { redactSensitiveText } from "../../src/main/services/sensitive-data.service";

describe("sensitive-data.service", () => {
  it("redacts API keys, bearer tokens, and assigned secrets", () => {
    const redacted = redactSensitiveText([
      "OPENAI_API_KEY=sk-1234567890abcdefghijkl",
      "Authorization: Bearer abcdefghijklmnopqrstuvwxyz",
      "password: super-secret-value"
    ].join("\n"));

    expect(redacted).not.toContain("sk-1234567890abcdefghijkl");
    expect(redacted).not.toContain("abcdefghijklmnopqrstuvwxyz");
    expect(redacted).not.toContain("super-secret-value");
    expect(redacted.match(/\[REDACTED]/g)?.length).toBeGreaterThanOrEqual(3);
  });
});
