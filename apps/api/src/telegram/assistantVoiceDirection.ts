import { ASSISTANT_COLLEAGUE_GREETING, ASSISTANT_GROUP_GREETING } from "./assistantGroupPhrases.js";

const GROUP_WELCOMES = new Set<string>([...Object.values(ASSISTANT_COLLEAGUE_GREETING), ...Object.values(ASSISTANT_GROUP_GREETING)]);
const GREETING = /^(?:коллеги,? привет|всем привет|здравствуй(?:те)?|добрый (?:день|вечер)|добро пожаловать|привет|салом|ассалому алейкум|хуш омадед)(?!\p{L})/iu;
const SERIOUS = /(?<!\p{L})(?:соболезн\p{L}*|сочувств\p{L}*|мне (?:очень )?жаль|умер\p{L}*|смерт\p{L}*|похорон\p{L}*|горе|скорб\p{L}*|трагеди\p{L}*|беда|груст\p{L}*|печал\p{L}*|плач\p{L}*|болеет|не удалось|не получилось|не справ\p{L}*|ошибк\p{L}*|таслият|вафот|даргузашт\p{L}*|марг\p{L}*|ҳамдард\p{L}*|ғам\p{L}*|андӯҳ\p{L}*|гиря|мутаассиф\p{L}*|афсӯс|мушкил\p{L}*|хатогӣ|нашуд\p{L}*|намешавад|ҷавоб надод\p{L}*|ба охир нарасид\p{L}*|кор накард\p{L}*)(?!\p{L})/iu;
const WORK_FACT = /\p{N}|(?<!\p{L})(?:CRM|цен\p{L}*|сумм\p{L}*|сомон\p{L}*|объект\p{L}*|квартир\p{L}*|(?:пере)?монтаж\p{L}*|показ\p{L}*|статус\p{L}*|очеред\p{L}*|задач\p{L}*|заявк\p{L}*|карточк\p{L}*|договор\p{L}*|оплат\p{L}*|нарх\p{L}*|ҳолат\p{L}*|навбат\p{L}*|супориш\p{L}*|намоиш\p{L}*|муштар\p{L}*|хона\p{L}*|муҳлат\p{L}*|тасдиқ\p{L}*|пардохт\p{L}*|соат\p{L}*|рақам\p{L}*|доллар\p{L}*|навор\p{L}*|корт\p{L}*)(?!\p{L})/iu;
const sentences = new Intl.Segmenter("ru", { granularity: "sentence" });
const MAX_CUES = 2;

type Cue = "[warmly]" | "[laughs]" | "[giggling]" | "[delighted]" | "[exhales]" | "[curious]";

function cueFor(text: string): { cue: Cue; text: string } | null {
  if (text.length > 145) return null;
  if (/^(?:вот это смешно|рассмешил(?:а|и)?|ин бисёр хандаовар аст|маро хандонд[ӣе]д?)(?!\p{L})/iu.test(text)) return { cue: "[laughs]", text };
  const chuckle = /^(?:ха[ -]ха|хе[ -]хе)[,!.— ]*\s+(.+)$/iu.exec(text);
  if (chuckle) return { cue: "[giggling]", text: chuckle[1] };
  if (/^(?:ну и шутка|хорошая шутка|вот это шутка|чӣ шӯхии хуб|шӯхии хуб)(?!\p{L})/iu.test(text)) return { cue: "[giggling]", text };
  if (/^(?:ура|поздравляю|вот это здорово|офарин|табрик(?: мекунам)?|муборак|хабари хуш)(?!\p{L})/iu.test(text)) return { cue: "[delighted]", text };
  if (/^(?:фух|ну вот, (?:теперь )?вс[её] получилось|хайрият|худоро шукр)(?!\p{L})/iu.test(text)) return { cue: "[exhales]", text };
  if (text.endsWith("?") && /^(?:интересно|мне интересно|ҷолиб|ба ман ҷолиб аст)(?!\p{L})/iu.test(text)) return { cue: "[curious]", text };
  if (GREETING.test(text) || /^(?:отлично|спасибо|рада помочь|приятно слышать|ташаккур|раҳмат|хушҳолам|(?:хуб|ҳа),\s*фаҳмидам|ҳозир мебинам)(?!\p{L})/iu.test(text)) return { cue: "[warmly]", text };
  return null;
}

/** Select short, allowlisted cues in speech only. Literal tags from the reply are never forwarded. */
export function directAssistantVoice(speech: string): string {
  const plain = speech
    .replace(/\[(?:[a-z][a-z ,'-]{0,65}|смех|улыбается|плачет|грустно|вздыхает|ханда|гиря|ғамгин)\]/giu, " ")
    .replace(/[[\]]/gu, "")
    .replace(/\s{2,}/gu, " ").trim();
  if (!plain || SERIOUS.test(plain)) return plain;
  if (GROUP_WELCOMES.has(plain)) {
    // Preserve the performance and cache identity of the fixed welcome recordings.
    const [, first, rest] = /^(.{6,105}?[.!?]) (.+)$/u.exec(plain) ?? [];
    return first ? `[warmly] ${first} [pause] ${rest}` : `[warmly] ${plain}`;
  }

  const parts = [...sentences.segment(plain)].map(({ segment }) => segment.trim());
  const facts = parts.map(part => WORK_FACT.test(part));
  const lastFact = facts.lastIndexOf(true);
  let activeCue: Cue | null = null;
  let used = 0;
  return parts.map((part, i) => {
    if (facts[i]) {
      if (!activeCue) return part;
      activeCue = null;
      used++;
      return `[neutral tone] ${part}`;
    }
    const direction = cueFor(part);
    // If facts follow, leave room to reset the delivery before reading them.
    const available = MAX_CUES - (i < lastFact ? 1 : 0);
    if (direction && direction.cue !== activeCue && used < available) {
      activeCue = direction.cue;
      used++;
      return `${direction.cue} ${direction.text}`;
    }
    if (!direction && parts.length === 2 && i === 1 && GREETING.test(parts[0])
      && activeCue === "[warmly]" && part.length <= 75 && part.endsWith("?")) {
      return `[exhales] ${part}`;
    }
    // A short dash gives a deliberate beat without adding another direction.
    return part.replace(/^(самое главное|вот что важно|муҳимаш|аз ҳама муҳим):\s*/iu, "$1 — ");
  }).join(" ");
}
