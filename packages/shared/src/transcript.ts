/**
 * Расшифровка разговора: разбор «Кто: текст» и склейка осколков одной реплики.
 *
 * Живой голос пишет расшифровку кусками потока («Бот: Здрав» / «Бот: ствуйте»),
 * по строке на кусок. Склейка лежит здесь (одно правило на сервер и сайт): сервер
 * клеит превью списка, сайт — пузыри разговора.
 */

/** Слова-говорящие в начале строки расшифровки; после — двоеточие или тире. */
export const TRANSCRIPT_SPEAKER_RE =
  /^(агент|клиент|сотрудник|оператор|бот|консультант|робот|ассистент)\s*[:\-—] ?/i;

/** Служебная строка в квадратных скобках: «[эскалация к оператору] …». */
export const TRANSCRIPT_SYSTEM_LINE_RE = /^\[[^\]\n]+\]/;

/**
 * Строка замеров звонка робота (09.10.2026): «[метрики] {json}» в самом конце
 * расшифровки сессии. Читает её разбор звонков (scripts/robot-call-metrics.mjs), людям на
 * экране она не показывается — mergeTranscriptFragments её убирает.
 */
export const LIVE_VOICE_METRICS_LINE_PREFIX = "[метрики] ";

/** Склеивает два куска одной реплики (экспорт — для живой ленты прослушки). */
export function joinTranscriptFragments(prev: string, next: string): string {
  if (!next) return prev;
  if (!prev) return next;
  if (/\s$/.test(prev) || /^\s/.test(next)) return prev + next;
  // Кусок посреди слова («Здрав» + «ствуйте») или знак препинания — без пробела.
  if (/^[\p{Ll},.!?…:;)»"']/u.test(next)) return prev + next;
  return `${prev} ${next}`;
}

/**
 * Склеивает подряд идущие строки одного говорящего в одну реплику. Служебные
 * строки в скобках, пустые строки и строки-продолжения обрывают склейку.
 */
export function mergeTranscriptFragments(text: string): string {
  const out: string[] = [];
  let curKey: string | null = null;
  for (const line of text.split("\n")) {
    const trimmed = line.trimStart();
    // Замеры звонка — для разбора, не для чтения глазами.
    if (trimmed.startsWith(LIVE_VOICE_METRICS_LINE_PREFIX)) continue;
    const m = TRANSCRIPT_SPEAKER_RE.exec(trimmed);
    if (!m) {
      curKey = null;
      out.push(line);
      continue;
    }
    const key = m[1].toLowerCase();
    const content = trimmed.slice(m[0].length);
    if (curKey === key && out.length > 0) {
      out[out.length - 1] = joinTranscriptFragments(out[out.length - 1], content);
    } else {
      curKey = key;
      out.push(trimmed);
    }
  }
  return out.join("\n");
}
