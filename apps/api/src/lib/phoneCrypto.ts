import crypto from "node:crypto";

/**
 * Шифрование запасных номеров, которые клиент называет ВО ВРЕМЯ ЗВОНКА, а не тех,
 * что уже лежат в карточке (03.09.2026, требование владельца).
 *
 * ЗАЧЕМ. Расшифровку разговора видит любой агент с правом calls.ownTranscripts
 * (lib/callTranscripts.ts) — карточка клиента, лента взаимодействий. Если номер,
 * который клиент назвал в разговоре, осесть в этом тексте как есть, агент может
 * просто списать его себе и договориться с клиентом напрямую, в обход CRM — тот
 * же обход системы, который уже разбирали для переписки (см.
 * lib/agentPhoneAskDetector.ts), только через звонок, а не через чат. Основной
 * номер клиента (Client.phone) этой проблемы не создаёт — он и так открыт агенту
 * через саму карточку; речь только про НОВЫЙ, ранее неизвестный номер.
 *
 * СХЕМА — та же, что уже используется в apps/api/src/crypto.ts
 * (encryptSecret/decryptSecret: AES-256-GCM, формат iv:authTag:ciphertext в hex),
 * но СВОИМ ключом (PHONE_ENCRYPTION_KEY), а не SETTINGS_ENCRYPTION_KEY: утечка
 * одного ключа не должна открывать сразу оба разных по чувствительности хранилища
 * (настройки/токены интеграций и личные номера телефонов клиентов).
 *
 * ПРЕДЕЛ ЭТОЙ ЗАЩИТЫ (честно, а не только в отчёте). Шифруется и маскируется
 * ТЕКСТ расшифровки — то, что агент читает глазами и может скопировать не глядя.
 * Агент с правом calls.ownTranscripts по-прежнему может ПРОСЛУШАТЬ саму запись
 * разговора и записать номер на слух — маскировка текста эту дыру не закрывает.
 * Заглушить произнесённые цифры в самой аудиозаписи — отдельная, гораздо более
 * крупная задача (нужно найти отрезок аудио с номером и вырезать/запикать его),
 * и она сознательно не берётся в этом заходе.
 */
const ALGO = "aes-256-gcm";

/** 32-байтный ключ (64 hex-символа), задаётся в .env: PHONE_ENCRYPTION_KEY.
 *  Сгенерировать: `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"`. */
function getKey(): Buffer {
  const raw = process.env.PHONE_ENCRYPTION_KEY;
  if (!raw || raw.length !== 64) {
    throw new Error(
      "PHONE_ENCRYPTION_KEY не задан или имеет неверную длину — нужен 32-байтный ключ в hex (64 символа)"
    );
  }
  return Buffer.from(raw, "hex");
}

/** Шифрует номер перед записью в БД. Формат: iv:authTag:ciphertext, всё в hex
 *  (тот же формат, что у encryptSecret в crypto.ts — узнаваемый в проекте приём). */
export function encryptPhone(plaintext: string): string {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv(ALGO, getKey(), iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return `${iv.toString("hex")}:${authTag.toString("hex")}:${ciphertext.toString("hex")}`;
}

/** Расшифровывает номер, прочитанный из БД. Бросает исключение при повреждённых/неверных данных. */
export function decryptPhone(payload: string): string {
  const parts = payload.split(":");
  if (parts.length !== 3) throw new Error("Неверный формат зашифрованного номера");
  const [ivHex, authTagHex, ciphertextHex] = parts;
  const decipher = crypto.createDecipheriv(ALGO, getKey(), Buffer.from(ivHex, "hex"));
  decipher.setAuthTag(Buffer.from(authTagHex, "hex"));
  const plaintext = Buffer.concat([decipher.update(Buffer.from(ciphertextHex, "hex")), decipher.final()]);
  return plaintext.toString("utf8");
}

/**
 * Что видит агент в расшифровке ВМЕСТО настоящих цифр — последние две видны,
 * остальные заменены на «*», разделители исходной записи (пробелы/дефисы)
 * сохраняются как есть. Две видимые цифры в конце — не ради удобства опознать
 * номер (это не нужно), а чтобы результат явно читался как «здесь был номер,
 * его скрыли», а не как случайно оборванный текст.
 */
const VISIBLE_TAIL_DIGITS = 2;

export function maskPhoneRaw(raw: string): string {
  const totalDigits = (raw.match(/\d/g) ?? []).length;
  let seen = 0;
  return raw.replace(/\d/g, (digit) => {
    seen += 1;
    return seen > totalDigits - VISIBLE_TAIL_DIGITS ? digit : "*";
  });
}
