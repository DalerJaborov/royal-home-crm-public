import { formatShortCode } from "@royal-home/shared";
import { prisma } from "../db.js";

/**
 * ВСЕ ТЕКСТЫ, КОТОРЫЕ CRM САМА ПИШЕТ МОНТАЖЁРУ, В ОДНОМ МЕСТЕ (28.11.2026, владелец: упростить
 * автосообщения монтажёру; план docs/plans/montajer-messages-2026-11-27.md).
 *
 * Было: шаблоны размазаны по двенадцати файлам, номер то «Объект №N», то «ОБ-…», то «ролик №N»,
 * голос объявлялся трижды на одну передачу. Здесь два набора с одинаковым видом:
 *  - SHORT (рубильник Settings.montajerShortMessages, по умолчанию ВКЛ): на «вы», короткие
 *    предложения, номер всегда «Объект №N», без длинных тире, слово «голос» вместо «озвучка версии…»,
 *    тип файла в начале подписи (🎬 видео, 🎙 голос);
 *  - LEGACY: прежние тексты слово в слово, на случай если рубильник выключат. Удалить после недели
 *    спокойной работы коротких.
 *
 * Не трогается ни в одном режиме (из них читают назад или по ним живёт структура): первая строка
 * квитанции о приёме (telegram/montajerReceive.ts::handoffReceiptText, её читает «✅ Что я сдал»),
 * имена файлов (videoHandoff.ts::montajerFileName), коды кнопок mj:*, вид MontajerMessage, формат фактов
 * propertyFactsForMontajer (его разбирают cardFactsDiff и clipPriceInFrame) и маркер «\n\nТекст:\n» в подписи
 * голоса (его режет narrationDelivery.ts::narrationCopyMessages).
 */

/** Состояние голоса объекта для строки в задании (lib/narrationMontajerNote.ts::narrationNoteForMontajer). */
export type MontajerNarrationNote =
  | "off" // агент выбрал «Без озвучки»
  | "mix" // голос накладывает CRM (mixByCrm): прислать ролик без голоса
  | "preparing" // CRM готовит голос
  | "manual" // старая ручная озвучка маркетинга, сама не придёт
  | "follows" // одобрен и уйдёт следом за файлами этой выдачи
  | "later" // одобрен, но уйдёт не сейчас
  | "delayed" // кончились кредиты сервиса озвучки
  | "delayedNotified" // то же, но монтажёру об этом уже написано отдельным сообщением
  | "awaitingApproval"; // ждёт одобрения

/** Голос в подписи mp3: mix — голос кладёт CRM, soundOnly — заменить только голос, plain — вклеить самому. */
export type MontajerVoiceCaptionMode = "mix" | "soundOnly" | "plain";

export interface MontajerHandoffBody {
  /** propertyFactsForMontajer: первая строка «Объект №N», дальше «Поле: значение». */
  facts: string;
  /** Только legacy: «\n\nДальше в очереди: …» или "". */
  queueLine: string;
  narration: MontajerNarrationNote | null;
  /** Беззвучные исходники: имя файла и место в наборе (1-based) из total. */
  silent: { filename: string; position: number }[];
  total: number;
  voiceHint: string;
}

export interface MontajerRemakeBody extends MontajerHandoffBody {
  shortId: number | string;
  reasonLabel: string;
  /** Причина NARRATION_CHANGED: голос меняется, строку про голос оставляем всегда. */
  voiceChanges: boolean;
  comment: string | null;
  /** Строки «что изменилось»: label, было (undefined — не было), стало (undefined — стёрли). */
  diff: { label: string; was?: string; becomes?: string }[] | null;
}

export interface MontajerTexts {
  readonly short: boolean;
  /** Первая строка подписи каждого исходника. `video` — факты файла для этой строки. */
  fileCaptionHead(shortId: number, index: number, total: number, video: { rawFacts: string; sizeBytes: number; durationSec?: number | null; hasAudio?: boolean | null }): string;
  /** Подпись файлов 2..N после шапки; null — только шапка. */
  restFileBody(facts: string): string | null;
  handoffBody(input: MontajerHandoffBody): string;
  remakeBody(input: MontajerRemakeBody): string;
  narrationLine(note: MontajerNarrationNote, voiceHint: string): string | null;
  /** Хвост итога, когда голос уйдёт следом (legacy — отдельной строкой). */
  voiceNextLine(mixByCrm: boolean, voiceHint: string): string;
  deliveryControl(shortId: number, delivered: number, total: number, voiceNext: string | null): string;
  heavyFile(head: string, megabytes: string, link: string | null): string;
  giveUpLink(shortId: number, file: { filename: string; position: number; total: number }, link: string | null): string;
  voiceCaption(shortId: number, revision: number, mode: MontajerVoiceCaptionMode, voiceHint: string): string;
  sourceWithVoiceCaption(shortId: number, revision: number, facts: string): string;
  narrationDelayed(shortId: number): string;
  narrationOff(shortId: number): string;
  /** `changes` — строки правки; legacy их не использует (берёт готовую сводку `legacySummary`). */
  factsChanged(shortId: number, legacySummary: string, changes: string[]): string;
  /** Одна строка правки поля: legacy «Этаж: 3 → 4», short «Этаж: было 3, стало 4». */
  changeLine(label: string, was: string, becomes: string): string;
  handoffCancelled(shortId: number, reason: string): string;
  handedOver(shortId: number): string;
  whoseClip(input: { holder: number | null; skipped: number[] }): { text: string; buttonLabel: (n: number) => string; neitherLabel: string };
  notWaiting(input: { declared: number; exists: boolean; holder: number | null; withButton: boolean }): { text: string; buttonLabel: (n: number) => string };
}

/** «из 1 файла», «из 15 файлов», «из 21 файла» — родительный после «из». */
function filesAfterIz(count: number): string {
  return count % 10 === 1 && count % 100 !== 11 ? "файла" : "файлов";
}

/** Факты без первой строки «Объект №N»: номер уже стоит в шапке подписи. */
function factsWithoutNumber(facts: string): string {
  const lines = facts.split("\n");
  return /^Объект №/.test(lines[0] ?? "") ? lines.slice(1).join("\n") : facts;
}

function formatDuration(sec: number): string {
  const total = Math.round(sec);
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, "0")}`;
}

/** Длинное тире из причин в чужих модулях («готов — ролик загрузили из CRM») — в коротком тексте двоеточием. */
function withoutDash(text: string): string {
  return text.replace(/\s*[—–]\s*/g, ": ");
}

const LEGACY_NARRATION_LINES: Record<MontajerNarrationNote, (hint: string) => string> = {
  off: () => "🔇 Без озвучки: голос в ролик не нужен.",
  mix: () => "🎙 Озвучку накладывает CRM: пришлите ролик БЕЗ голоса (музыка и звуки можно).",
  preparing: (hint) => `🎙 Озвучка готовится и придёт сюда, как будет готова, — вклейте её сами.${hint}`,
  manual: () => "🎙 Озвучку этого объекта ведёт маркетинг вручную: сама она сюда не придёт. Нужна — спросите маркетинг.",
  follows: (hint) => `🎙 Озвучка одобрена: mp3 придёт сразу после файлов ролика — вклейте её сами.${hint}`,
  later: (hint) => `🎙 Озвучка придёт сюда, как будет готова, — вклейте её сами.${hint}`,
  delayed: () => "🎙 Озвучка задерживается: сервис озвучки на паузе. Придёт сюда, как будет готова.",
  delayedNotified: () => "🎙 Озвучка задерживается: сервис озвучки на паузе. Придёт сюда, как будет готова.",
  awaitingApproval: (hint) => `🎙 Озвучка ждёт одобрения и придёт сюда, как будет готова, — вклейте её сами.${hint}`,
};

/**
 * Короткая строка про голос. «follows» — null: про голос, который уйдёт следом, говорит итог
 * («Голос придёт следом.»), а подпись mp3 — что с ним делать (решение владельца 28.11.2026: объявлять
 * один раз). «delayedNotified» — null: монтажёр уже получил «голос задерживается» отдельным сообщением.
 */
const SHORT_NARRATION_LINES: Record<MontajerNarrationNote, ((hint: string) => string) | null> = {
  off: () => "🔇 Голос в ролик не нужен.",
  mix: () => "🎙 Голос наложит CRM: пришлите ролик без голоса, музыка и звуки можно.",
  preparing: (hint) => `🎙 Голос готовится и придёт отдельным файлом, вклейте его сами.${hint}`,
  manual: () => "🎙 Голос ведёт маркетинг вручную, сюда он сам не придёт.",
  follows: null,
  later: (hint) => `🎙 Голос придёт отдельным файлом позже, вклейте его сами.${hint}`,
  delayed: () => "🎙 Голос задерживается, он придёт отдельным файлом.",
  delayedNotified: null,
  awaitingApproval: (hint) => `🎙 Голос ждёт одобрения и придёт отдельным файлом, вклейте его сами.${hint}`,
};

export const LEGACY_MONTAJER_TEXTS: MontajerTexts = {
  short: false,
  fileCaptionHead: (shortId, index, total, video) =>
    `Объект №${shortId} · файл ${index + 1} из ${total}${video.rawFacts ? ` · ${video.rawFacts}` : ""}`,
  restFileBody: (facts) => facts || null,
  handoffBody: ({ facts, queueLine, narration, silent, voiceHint }) => {
    const narrationLine = narration ? LEGACY_NARRATION_LINES[narration](voiceHint) : null;
    const silentNote = silent.length ? `⚠ Без звука: ${silent.map((v) => v.filename).join(", ")} — звук/музыку наложите при монтаже` : null;
    return `${facts}${queueLine}${narrationLine ? `\n\n${narrationLine}` : ""}${silentNote ? `\n\n${silentNote}` : ""}`;
  },
  remakeBody: ({ shortId, reasonLabel, comment, diff, narration, facts, silent, voiceHint }) => {
    const lines = [`🔁 ПЕРЕМОНТАЖ, объект №${shortId}`, `Причина: ${reasonLabel}`];
    if (comment) lines.push(comment);
    if (diff && diff.length > 0) {
      lines.push("", "Что изменилось в карточке:", ...diff.map((d) => `• ${legacyDiffLine(d)}`));
    }
    const narrationLine = narration ? LEGACY_NARRATION_LINES[narration](voiceHint) : null;
    if (narrationLine) lines.push("", narrationLine);
    lines.push("", facts);
    if (silent.length) lines.push("", `⚠ Без звука: ${silent.map((v) => v.filename).join(", ")} — звук/музыку наложите при монтаже`);
    return lines.join("\n");
  },
  narrationLine: (note, hint) => LEGACY_NARRATION_LINES[note](hint),
  voiceNextLine: (mixByCrm, hint) =>
    mixByCrm ? "🎙 Озвучка — следующим сообщением: под неё длина и темп." : `🎙 Озвучка — следующим сообщением, вклейте её сами.${hint}`,
  deliveryControl: (shortId, delivered, total, voiceNext) =>
    [
      delivered >= total
        ? `Отправлено ${total} из ${total} ${filesAfterIz(total)} объекта №${shortId}.`
        : `Объект №${shortId}: дошло ${delivered} из ${total} ${filesAfterIz(total)}, остальное дошлю автоматически.`,
      voiceNext,
    ]
      .filter(Boolean)
      .join("\n\n"),
  heavyFile: (head, mb, link) =>
    link
      ? `${head}\n\nФайл ${mb} МБ — тяжелее, чем принимает Telegram. Скачать: ${link}`
      : `${head}\n\nФайл ${mb} МБ — тяжелее, чем принимает Telegram. Заберите через карточку объекта в CRM.`,
  giveUpLink: (shortId, file, link) =>
    link
      ? `Объект №${shortId}: ролик «${file.filename}» так и не дошёл файлом после всех попыток. Ссылка на скачивание: ${link}`
      : `Объект №${shortId}: ролик «${file.filename}» так и не дошёл файлом после всех попыток, а ссылка недоступна (не настроен публичный адрес CRM) — заберите через карточку объекта в CRM.`,
  voiceCaption: (shortId, revision, mode, hint) =>
    mode === "mix"
      ? `Объект №${shortId}. Озвучка, версия ${revision}: под неё длина и темп. Пришлите ролик БЕЗ голоса (музыка и звуки можно), голос CRM наложит сама. Ролик не короче озвучки.`
      : mode === "soundOnly"
        ? `Озвучка к ролику №${shortId}, версия ${revision}: замените в ролике только голос, музыку и монтаж не трогайте.${hint}`
        : `Озвучка к ролику №${shortId}, версия ${revision}, одобрена. Вклейте этот голос сами: музыка, громкость и монтаж ваши.${hint}`,
  sourceWithVoiceCaption: (shortId, revision, facts) => `Объект №${shortId}. Исходник. Озвучка v${revision}.\n${facts}`,
  narrationDelayed: (shortId) =>
    `Объект №${shortId}: озвучка задерживается, сервис озвучки на паузе. Монтируйте как обычно, mp3 придёт сюда отдельным файлом.`,
  narrationOff: (shortId) => `Объект №${shortId}: агент выбрал «Без озвучки» — голос в ролик не нужен.`,
  factsChanged: (shortId, legacySummary) => `⚠️ В карточке ${formatShortCode("ОБ", shortId)} изменилось: ${legacySummary}. Учтите в монтаже.`,
  changeLine: (label, was, becomes) => `${label}: ${was} → ${becomes}`,
  handoffCancelled: (shortId, reason) => `Объект №${shortId} ${reason} — доделывать не нужно, ролик можно не присылать.`,
  handedOver: (shortId) => `Объект №${shortId} передан другому монтажёру.`,
  whoseClip: ({ holder, skipped }) => ({
    text: `Чей это ролик? В имени файла нет номера объекта. ${holder != null ? `Сейчас у вас в работе №${holder}. ` : ""}Недавно вы пропускали ${skipped.map((n) => `№${n}`).join(", ")}. Нажмите номер объекта.`,
    buttonLabel: (n) => `Это №${n}`,
    neitherLabel: "Ни то, ни другое",
  }),
  notWaiting: ({ declared, exists, holder, withButton }) => {
    const what = exists ? `Объект №${declared} сейчас не ждёт от вас ролик.` : `Объекта №${declared} в CRM нет.`;
    const inWork = holder != null ? ` Сейчас у вас в работе №${holder}.` : "";
    const text = `${what}${inWork} Файл не принят. Если это ролик для объекта в работе — пришлите его с номером этого объекта в имени файла или в подписи.`;
    return {
      text: withButton && holder != null ? `${text}\nИли нажмите кнопку, если это всё-таки ролик для №${holder}.` : text,
      buttonLabel: (n) => `Это №${n}`,
    };
  },
};

function legacyDiffLine(d: { label: string; was?: string; becomes?: string }): string {
  if (d.was === undefined) return `${d.label}: добавилось — ${d.becomes}`;
  if (d.becomes === undefined) return `${d.label}: было «${d.was}», теперь не указано`;
  return `${d.label}: «${d.was}» → «${d.becomes}»`;
}

function shortDiffLine(d: { label: string; was?: string; becomes?: string }): string {
  if (d.was === undefined) return `${d.label}: добавилось ${d.becomes}`;
  if (d.becomes === undefined) return `${d.label}: было ${d.was}, теперь не указано`;
  return `${d.label}: было ${d.was}, стало ${d.becomes}`;
}

function shortSilentLine(silent: { position: number }[], total: number): string | null {
  if (silent.length === 0) return null;
  if (total === 1) return "⚠ Видео без звука, звук наложите при монтаже.";
  return `⚠ Без звука: видео ${silent.map((v) => v.position).join(", ")}. Звук наложите при монтаже.`;
}

function shortFileFacts(video: { sizeBytes: number; durationSec?: number | null; hasAudio?: boolean | null }): string {
  const mb = video.sizeBytes / 1024 / 1024;
  const parts = video.sizeBytes > 0 ? [mb < 0.5 ? "<1 МБ" : `${Math.round(mb)} МБ`] : [];
  if (video.durationSec != null && video.durationSec > 0) parts.push(formatDuration(video.durationSec));
  if (video.hasAudio === true) parts.push("со звуком");
  if (video.hasAudio === false) parts.push("⚠ без звука");
  return parts.join(", ");
}

export const SHORT_MONTAJER_TEXTS: MontajerTexts = {
  short: true,
  fileCaptionHead: (shortId, index, total, video) =>
    [`Объект №${shortId}`, `🎬 видео${total > 1 ? ` ${index + 1} из ${total}` : ""}`, shortFileFacts(video)].filter(Boolean).join(" · "),
  // Факты только под первым файлом (владелец 28.11.2026): у остальных номер в шапке и в имени файла.
  restFileBody: () => null,
  handoffBody: ({ facts, narration, silent, total, voiceHint }) => {
    const narrationLine = narration ? SHORT_NARRATION_LINES[narration]?.(voiceHint) ?? null : null;
    return [factsWithoutNumber(facts), narrationLine, shortSilentLine(silent, total)].filter(Boolean).join("\n\n");
  },
  remakeBody: ({ shortId, reasonLabel, comment, diff, narration, voiceChanges, facts, silent, total, voiceHint }) => {
    const fix = withoutDash([reasonLabel.replace(/[.\s]+$/, ""), comment?.trim()].filter(Boolean).join(". "));
    const lines = [`🔁 Объект №${shortId} на переделку`, `Что исправить: ${/[.!?]$/.test(fix) ? fix : `${fix}.`}`];
    if (diff && diff.length > 0) lines.push("", "Что изменилось в карточке:", ...diff.map((d) => `• ${shortDiffLine(d)}`));
    // Строка про голос в переделке — только когда голос меняется или указание про голос и есть суть задания.
    const keepVoice = voiceChanges || narration === "off" || narration === "mix";
    const narrationLine = narration && keepVoice ? SHORT_NARRATION_LINES[narration]?.(voiceHint) ?? null : null;
    if (narrationLine) lines.push("", narrationLine);
    lines.push("", factsWithoutNumber(facts));
    const silentLine = shortSilentLine(silent, total);
    if (silentLine) lines.push("", silentLine);
    return lines.join("\n");
  },
  narrationLine: (note, hint) => SHORT_NARRATION_LINES[note]?.(hint) ?? null,
  voiceNextLine: () => "Голос придёт следом.",
  deliveryControl: (shortId, delivered, total, voiceNext) =>
    delivered >= total
      ? `Объект №${shortId}: ${total} видео отправлено.${voiceNext ? ` ${voiceNext}` : ""}`
      : `Объект №${shortId}: дошло ${delivered} из ${total} видео, остальное дошлём сами.`,
  heavyFile: (head, mb, link) =>
    link
      ? `${head}\n\nФайл ${mb} МБ, Telegram такой не принимает. Скачайте по ссылке: ${link}`
      : `${head}\n\nФайл ${mb} МБ, Telegram такой не принимает. Заберите его в карточке объекта в CRM.`,
  giveUpLink: (shortId, file, link) => {
    const which = file.total > 1 ? `видео ${file.position} из ${file.total}` : "видео";
    return link
      ? `Объект №${shortId}: ${which} не дошло файлом. Скачайте по ссылке: ${link}`
      : `Объект №${shortId}: ${which} не дошло файлом, а ссылки нет. Заберите его в карточке объекта в CRM.`;
  },
  voiceCaption: (shortId, revision, mode, hint) =>
    mode === "mix"
      ? `Объект №${shortId} · 🎙 голос, версия ${revision}. Под него длина и темп. Пришлите ролик без голоса, музыка и звуки можно, голос наложит CRM. Ролик не короче голоса.`
      : mode === "soundOnly"
        ? `Объект №${shortId} · 🎙 новый голос, версия ${revision}. Замените в ролике только голос, остальное не трогайте.${hint}`
        : `Объект №${shortId} · 🎙 голос, версия ${revision}. Вклейте его сами, музыка и громкость на вас.${hint}`,
  sourceWithVoiceCaption: (shortId, revision, facts) => `Объект №${shortId} · 🎬 исходник к голосу, версия ${revision}\n${factsWithoutNumber(facts)}`,
  narrationDelayed: (shortId) => `Объект №${shortId}: голос задерживается. Монтируйте как обычно, он придёт отдельным файлом.`,
  narrationOff: (shortId) => `Объект №${shortId}: голос в ролик не нужен.`,
  factsChanged: (shortId, _legacySummary, changes) => {
    const body = changes.join("; ").replace(/[.\s]+$/, "");
    return `⚠️ Объект №${shortId}: в карточке изменилось. ${withoutDash(body)}. Учтите в монтаже.`;
  },
  changeLine: (label, was, becomes) => `${label}: было ${was}, стало ${becomes}`,
  handoffCancelled: (shortId, reason) => `Объект №${shortId} ${withoutDash(reason)}. Монтировать не нужно, ролик присылать не надо.`,
  handedOver: (shortId) => `Объект №${shortId} передан другому монтажёру.`,
  whoseClip: ({ holder }) => ({
    text: "Чей это ролик? В имени файла нет номера. Нажмите объект:",
    buttonLabel: (n) => (n === holder ? `№${n} в работе` : `№${n}`),
    neitherLabel: "Другой",
  }),
  notWaiting: ({ declared, exists, holder, withButton }) => {
    const what = exists ? `объект №${declared} не ждёт ролик.` : `объекта №${declared} в CRM нет.`;
    const now = holder != null ? ` Сейчас у вас №${holder}.` : "";
    const example = holder != null ? `, например ${holder}.mp4` : "";
    const text = `Файл не принят: ${what}${now} Пришлите файл с номером объекта в имени${example}.`;
    return {
      text: withButton && holder != null ? `${text}\nИли нажмите кнопку, если это ролик для №${holder}.` : text,
      buttonLabel: (n) => `№${n} в работе`,
    };
  },
};

export function montajerTexts(short: boolean): MontajerTexts {
  return short ? SHORT_MONTAJER_TEXTS : LEGACY_MONTAJER_TEXTS;
}

/**
 * РУБИЛЬНИК «КОРОТКИЕ СООБЩЕНИЯ МОНТАЖЁРУ» (Settings.montajerShortMessages, по умолчанию ВКЛ). Читается
 * на каждое сообщение без кэша: сообщений монтажёру единицы в час, а переключатель в Настройках должен
 * действовать сразу. Не прочиталось — короткие (умолчание), сообщение важнее режима.
 */
export async function montajerShortMessagesEnabled(): Promise<boolean> {
  try {
    const s = await prisma.settings.findUnique({ where: { id: "singleton" }, select: { montajerShortMessages: true } });
    return s?.montajerShortMessages !== false;
  } catch {
    return true;
  }
}

export async function currentMontajerTexts(): Promise<MontajerTexts> {
  return montajerTexts(await montajerShortMessagesEnabled());
}
