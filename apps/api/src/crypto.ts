import crypto from "node:crypto";

const ALGO = "aes-256-gcm";

/** 32-байтный ключ (64 hex-символа), задаётся в .env: SETTINGS_ENCRYPTION_KEY.
 * Сгенерировать: `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"`. */
function getKey(): Buffer {
  const raw = process.env.SETTINGS_ENCRYPTION_KEY;
  if (!raw || raw.length !== 64) {
    throw new Error(
      "SETTINGS_ENCRYPTION_KEY не задан или имеет неверную длину — нужен 32-байтный ключ в hex (64 символа)"
    );
  }
  return Buffer.from(raw, "hex");
}

/** Шифрует секрет перед записью в БД (например, Anthropic API key). Формат: iv:authTag:ciphertext, всё в hex. */
export function encryptSecret(plaintext: string): string {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv(ALGO, getKey(), iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return `${iv.toString("hex")}:${authTag.toString("hex")}:${ciphertext.toString("hex")}`;
}

/** Расшифровывает секрет, прочитанный из БД. Бросает исключение при повреждённых/неверных данных. */
export function decryptSecret(payload: string): string {
  const parts = payload.split(":");
  if (parts.length !== 3) throw new Error("Неверный формат зашифрованного значения");
  const [ivHex, authTagHex, ciphertextHex] = parts;
  const decipher = crypto.createDecipheriv(ALGO, getKey(), Buffer.from(ivHex, "hex"));
  decipher.setAuthTag(Buffer.from(authTagHex, "hex"));
  const plaintext = Buffer.concat([decipher.update(Buffer.from(ciphertextHex, "hex")), decipher.final()]);
  return plaintext.toString("utf8");
}

/** Best-effort расшифровка: если значение записано ДО внедрения шифрования (или ключ не настроен),
 * возвращает исходную строку как есть, а не роняет запрос. Самовосстанавливается при следующем PATCH. */
export function decryptSecretSafe(payload: string | null): string | null {
  if (!payload) return null;
  try {
    return decryptSecret(payload);
  } catch {
    return payload;
  }
}
