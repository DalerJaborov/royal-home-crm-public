import { describe, expect, it } from "vitest";
import { summarizeManagedGeminiError } from "../src/ai/geminiClient.js";

/** Managed-отказ Google: в журнал идут только status/code/reason/field, никогда message и значения. */
describe("summarizeManagedGeminiError", () => {
  it("берёт только безопасные поля и не берёт message/description/значения", () => {
    const body = JSON.stringify({
      error: {
        code: 400,
        status: "INVALID_ARGUMENT",
        message: "phone +992931234567 SYNTHETIC_PRIVATE",
        details: [
          { "@type": "type.googleapis.com/google.rpc.ErrorInfo", reason: "API_KEY_INVALID", metadata: { value: "SECRET_VALUE" } },
          { fieldViolations: [{ field: "contents[0].parts[0]", description: "echo +992931234567" }] },
        ],
      },
    });
    const out = summarizeManagedGeminiError(body);
    expect(out).toBe("status=INVALID_ARGUMENT code=400 reason=API_KEY_INVALID field=contents[0].parts[0]");
    expect(out).not.toMatch(/992931234567|SYNTHETIC_PRIVATE|SECRET_VALUE|echo/);
  });

  it("значения не по формату отбрасываются (эхо промта под видом reason/field)", () => {
    const out = summarizeManagedGeminiError(
      JSON.stringify({ error: { status: "call me +992931234567", details: [{ reason: "has spaces and +992", fieldViolations: [{ field: "a b c" }] }] } })
    );
    expect(out).toBe("");
  });

  it("битый JSON и не-объект не роняют путь", () => {
    expect(summarizeManagedGeminiError("<html>502</html>")).toBe("");
    expect(summarizeManagedGeminiError("null")).toBe("");
    expect(summarizeManagedGeminiError("")).toBe("");
  });
});
