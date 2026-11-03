const SMALL = [
  "сифр", "як", "ду", "се", "чор", "панҷ", "шаш", "ҳафт", "ҳашт", "нӯҳ",
  "даҳ", "ёздаҳ", "дувоздаҳ", "сенздаҳ", "чордаҳ", "понздаҳ", "шонздаҳ",
  "ҳабдаҳ", "ҳаждаҳ", "нуздаҳ",
];
const TENS = ["", "", "бист", "сӣ", "чил", "панҷоҳ", "шаст", "ҳафтод", "ҳаштод", "навад"];
const SCALES = ["", "ҳазор", "миллион", "миллиард"];

function connect(first: string, next: string): string {
  if (first.endsWith("ӣ")) return `${first.slice(0, -1)}иву ${next}`;
  return `${first}${first.endsWith("у") || first.endsWith("а") || first.endsWith("о") || first.endsWith("е") ? "ю" : "у"} ${next}`;
}

function underThousand(number: number): string {
  if (number < 20) return SMALL[number];
  if (number < 100) {
    const tens = TENS[Math.floor(number / 10)];
    return number % 10 === 0 ? tens : connect(tens, SMALL[number % 10]);
  }
  const hundreds = Math.floor(number / 100);
  const word = hundreds === 1 ? "сад" : `${SMALL[hundreds]}сад`;
  return number % 100 === 0 ? word : connect(word, underThousand(number % 100));
}

function cardinal(number: number): string {
  if (number < 1000) return underThousand(number);
  for (let index = SCALES.length - 1; index > 0; index--) {
    const factor = 1000 ** index;
    if (number < factor) continue;
    const head = `${underThousand(Math.floor(number / factor))} ${SCALES[index]}`;
    const remainder = number % factor;
    return remainder === 0 ? head : connect(head, cardinal(remainder));
  }
  throw new RangeError("Unsupported Tajik speech number");
}

/**
 * Run on masked speech only. Expand unambiguous times and whole numbers.
 * Dates, decimals, codes and unrecognised notation stay in the written reply.
 */
export function tajikSpeechNumbers(text: string): string | null {
  const spoken = text
    .replace(/(?<![\p{L}\p{N}_:./+−–-])(\d{1,2}):(\d{2})(?![\p{L}\p{N}_]|[:./−–-]\d)/gu, (match, hours: string, minutes: string) => {
      const hour = Number(hours);
      const minute = Number(minutes);
      if (hour > 23 || minute > 59) return match;
      return minute === 0 ? cardinal(hour) : connect(cardinal(hour), cardinal(minute));
    })
    .replace(/(?<![\p{L}\p{N}_:./+−–-])(?:\d{1,3}(?:[ \u00a0\u202f]\d{3})+|\d+)(?:[ \u00a0\u202f]*%)?(?![\p{L}\p{N}_]|[.,:/−–-]\d)/gu, (match) => {
      const digits = match.replace(/[ \u00a0\u202f%]/g, "");
      if (digits.length > 12 || (digits.length > 1 && digits.startsWith("0"))) return match;
      const words = cardinal(Number(digits));
      return match.endsWith("%") ? `${words} фоиз` : words;
    });
  return /\p{N}/u.test(spoken) ? null : spoken;
}
