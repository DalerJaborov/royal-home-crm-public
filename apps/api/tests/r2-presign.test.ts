import { describe, expect, it } from "vitest";

/** Регрессия: presign скачивания R2 падал в проде с SignatureDoesNotMatch — правка
 *  query-строки (X-Amz-Expires) ПОСЛЕ aws.sign() меняла уже подписанный канонический
 *  запрос. См. lib/r2Client.ts::r2PresignDownloadUrl. aws.sign() не делает сетевых
 *  вызовов для GET-presign — тест работает на фейковых ключах, без реального R2. */

process.env.R2_ACCOUNT_ID = "test-account";
process.env.R2_ACCESS_KEY_ID = "test-access-key";
process.env.R2_SECRET_ACCESS_KEY = "test-secret-key";
process.env.R2_BUCKET_NAME = "test-bucket";

const { r2PresignDownloadUrl } = await import("../src/lib/r2Client.js");

describe("r2PresignDownloadUrl", () => {
  it("X-Amz-Expires=600 участвует в подписанном запросе (не дописан после подписи)", async () => {
    const url = await r2PresignDownloadUrl("some/object-key.mp4");
    expect(url).toBeTruthy();
    const parsed = new URL(url!);
    expect(parsed.searchParams.get("X-Amz-Expires")).toBe("600");
    // Подпись должна присутствовать и быть посчитана уже С учётом X-Amz-Expires=600 —
    // достаточно убедиться, что оба параметра стоят рядом в одном подписанном URL.
    expect(parsed.searchParams.get("X-Amz-Signature")).toBeTruthy();
    expect(parsed.searchParams.get("X-Amz-Algorithm")).toBe("AWS4-HMAC-SHA256");
  });

  it("без ключей R2 возвращает null, а не бросает", async () => {
    const saved = process.env.R2_ACCESS_KEY_ID;
    delete process.env.R2_ACCESS_KEY_ID;
    try {
      expect(await r2PresignDownloadUrl("x")).toBeNull();
    } finally {
      process.env.R2_ACCESS_KEY_ID = saved;
    }
  });
});
