import { extractPhoneOccurrences, unclearRawMatchesKnownTail } from "../shared/phoneText.js";
import { phoneTail } from "../clientPhones.js";
import { encryptPhone, maskPhoneRaw } from "../phoneCrypto.js";
import { logSystemError } from "../systemError.js";

/**
 * ЗАПАСНОЙ НОМЕР, НАЗВАННЫЙ КЛИЕНТОМ В ЗВОНКЕ, НЕ ДОЛЖЕН ОСЕДАТЬ В РАСШИФРОВКЕ
 * ОТКРЫТЫМ ТЕКСТОМ (03.09.2026, требование владельца).
 *
 * Разбор звонка (ai/callAnalysis.ts) уже ловит, когда АГЕНТ спрашивает номер —
 * см. lib/agentPhoneAskDetector.ts. Этот модуль — про обратный случай: КЛИЕНТ сам
 * называет номер, отличный от того, что уже есть на карточке (запасная симка,
 * другой телефон). Если оставить его в тексте как есть, агент, открывший
 * расшифровку в карточке или в ленте, просто спишет номер себе — тот же обход
 * CRM, который уже разбирали для переписки, только через звонок.
 *
 * ОСНОВНОЙ номер клиента (Client.phone/whatsappPhone/extraPhones) НЕ трогаем —
 * он и так открыт агенту через саму карточку, маскировать его в расшифровке
 * бессмысленно и только мешало бы читать разговор.
 */

export interface KnownClientPhones {
  phone: string;
  whatsappPhone: string | null;
  extraPhones: string[];
}

export interface ScrubbedTranscript {
  /** Текст для показа агенту — новые номера в нём заменены на «*». */
  text: string;
  /** Зашифрованные новые номера (по одному на уникальный номер) — для БД. */
  mentionedPhonesEncrypted: string[];
}

/**
 * Прячет из текста звонка номера, которых ещё нет на карточке клиента, и
 * возвращает их же зашифрованными — для внутренних целей системы (дедуп,
 * будущий поиск дублей карточек), а не для показа агенту.
 *
 * Маскируется КАЖДОЕ вхождение нового номера, а не только первое — клиент часто
 * диктует номер дважды подряд («записывайте... записал? повторю: …»), и вторая
 * подсказка не должна остаться нетронутой только потому, что номер уже «учтён».
 * Именно поэтому здесь используется extractPhoneOccurrences (без дедупа по
 * тексту), а не extractAllPhones — дедуп по номеру нужен только для списка на
 * шифрование, а не для того, что именно заменяется в строке.
 *
 * `includeUnclear: true` (24.09.2026) — рядом с обычными номерами маскируются и
 * кандидаты «неразборчиво» («918 84 ?? 54», модель честно не расслышала цифру,
 * см. PHONE_INNER_UNCLEAR в ai/leadQualifier.ts). Такой кандидат НЕ считается
 * телефоном (в нём не хватает цифры) и в шифрование ниже не идёт — известного
 * хвоста для сверки/дедупа у него нет, — но сами цифры так же принадлежат
 * клиенту и не должны оседать в расшифровке открытым текстом.
 */
export function scrubMentionedPhones(text: string, known: KnownClientPhones): ScrubbedTranscript {
  if (!text) return { text, mentionedPhonesEncrypted: [] };

  const knownTails = new Set(
    [known.phone, known.whatsappPhone, ...known.extraPhones]
      .filter((p): p is string => !!p)
      .map(phoneTail)
      .filter((t) => t.length > 0)
  );

  // `unclear` — правка ревью 24.09.2026: раньше ЛЮБОЙ неразобранный кандидат
  // проходил мимо проверки известных номеров (фильтр был `o.unclear || ...`,
  // то есть unclear пропускался безусловно). Из-за этого свой же ОСНОВНОЙ
  // номер клиента, если модель не расслышала в нём одну цифру («мой 918 84 ?5
  // 54»), маскировался в расшифровке — хотя он и так открыт агенту в карточке
  // (см. докстринг модуля). Сравниваем ПО ШАБЛОНУ (unclearRawMatchesKnownTail):
  // «?» совпадает с любой цифрой известного номера — точного совпадения от
  // кандидата с потерянной цифрой требовать нельзя.
  const occurrences = extractPhoneOccurrences(text, { includeUnclear: true }).filter((o) =>
    o.unclear ? !unclearRawMatchesKnownTail(o.raw, knownTails) : !knownTails.has(phoneTail(o.phone))
  );
  if (occurrences.length === 0) return { text, mentionedPhonesEncrypted: [] };

  let masked = text;
  for (const { raw } of occurrences) {
    // split/join вместо replace(regex): raw уже найден регэкспом ровно один раз
    // за проход, но встречается в тексте несколько раз (повтор номера) — split
    // по литеральной подстроке заменяет ВСЕ её вхождения разом, без риска
    // спецсимволов regex внутри raw (там только цифры и разделители, но лишний
    // экранизирующий шаг того не стоит).
    masked = masked.split(raw).join(maskPhoneRaw(raw));
  }

  // Один зашифрованный номер на уникальный хвост — иначе повторно продиктованный
  // номер лёг бы в БД дважды тем же значением. `unclear` пропускаем: цифра
  // потеряна, шифровать половинчатый номер значило бы сохранить то, чего клиент
  // не диктовал (см. докстринг выше) — такой кандидат только маскируется в тексте.
  const uniquePhones = new Map<string, string>();
  for (const { phone, unclear } of occurrences) {
    if (unclear) continue;
    const tail = phoneTail(phone);
    if (!uniquePhones.has(tail)) uniquePhones.set(tail, phone);
  }

  const mentionedPhonesEncrypted: string[] = [];
  for (const phone of uniquePhones.values()) {
    try {
      mentionedPhonesEncrypted.push(encryptPhone(phone));
    } catch (err) {
      // Ключ не настроен или повреждён — номер всё равно остаётся замаскированным
      // в тексте (это и есть главная защита), просто не попадёт в зашифрованное
      // хранилище для будущего дедупа. Не роняем разбор звонка из-за этого.
      void logSystemError(
        "api",
        `Номер, названный клиентом в звонке, замаскирован в расшифровке, но НЕ сохранён ` +
          `зашифрованным (PHONE_ENCRYPTION_KEY не настроен?): ${err instanceof Error ? err.message : String(err)}`
      );
    }
  }

  return { text: masked, mentionedPhonesEncrypted };
}
