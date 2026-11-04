import { ASSISTANT_COLLEAGUE_GREETING, ASSISTANT_GROUP_GREETING } from "./assistantGroupPhrases.js";

const GROUP_WELCOMES = new Set<string>([...Object.values(ASSISTANT_COLLEAGUE_GREETING), ...Object.values(ASSISTANT_GROUP_GREETING)]);
const GREETING = /^(?:коллеги,? привет|всем привет|здравствуй(?:те)?|добрый (?:день|вечер)|добро пожаловать|привет|салом|ассалому алейкум|хуш омадед)(?!\p{L})/iu;
const SERIOUS = /(?<!\p{L})(?:соболезн\p{L}*|сочувств\p{L}*|умер\p{L}*|смерт\p{L}*|похорон\p{L}*|горе|скорб\p{L}*|трагеди\p{L}*|беда|груст\p{L}*|печал\p{L}*|плач\p{L}*|болеет|не удалось|не получилось|не справ\p{L}*|ошибк\p{L}*|таслият|вафот|даргузашт\p{L}*|марг\p{L}*|ҳамдард\p{L}*|ғам\p{L}*|андӯҳ\p{L}*|гиря|мушкил\p{L}*|хатогӣ|нашуд|намешавад)(?!\p{L})/iu;
const WORK_FACT = /\p{N}|(?<!\p{L})(?:CRM|цен\p{L}*|сумм\p{L}*|сомон\p{L}*|объект\p{L}*|квартир\p{L}*|(?:пере)?монтаж\p{L}*|показ\p{L}*|статус\p{L}*|очеред\p{L}*|задач\p{L}*|заявк\p{L}*|карточк\p{L}*|договор\p{L}*|оплат\p{L}*|нарх\p{L}*|ҳолат\p{L}*|навбат\p{L}*|супориш\p{L}*|намоиш\p{L}*|муштар\p{L}*|хона\p{L}*|муҳлат\p{L}*|тасдиқ\p{L}*|пардохт\p{L}*)(?!\p{L})/iu;

/** Select short, allowlisted cues in speech only. Literal tags from the reply are never forwarded. */
export function directAssistantVoice(speech: string): string {
  const plain = speech
    .replace(/\[(?:[a-z][a-z ,'-]{0,65}|смех|улыбается|плачет|грустно|вздыхает|ханда|гиря|ғамгин)\]/giu, " ")
    .replace(/[[\]]/gu, "")
    .replace(/\s{2,}/gu, " ").trim();
  if (!plain) return "";
  if (SERIOUS.test(plain) || (WORK_FACT.test(plain) && !GROUP_WELCOMES.has(plain))) return plain;

  if (GREETING.test(plain)) {
    const boundary = /^(.{6,105}?[.!?]) (.+)$/u.exec(plain);
    if (!boundary) return `[warmly] ${plain}`;
    const [, first, rest] = boundary;
    const transition = rest.length <= 75 && rest.endsWith("?") && !/\p{N}/u.test(rest) ? "[exhales]" : "[pause]";
    return `[warmly] ${first} ${transition} ${rest}`;
  }
  if (plain.length > 145) return plain;
  if (/^(?:вот это смешно|рассмешил(?:а|и)?|ин бисёр хандаовар аст|маро хандонд[ӣе]д?)(?!\p{L})/iu.test(plain)) return `[laughs] ${plain}`;
  const chuckle = /^(?:ха[ -]ха|хе[ -]хе)[,!.— ]*\s+(.+)$/iu.exec(plain);
  if (chuckle) return `[giggling] ${chuckle[1]}`;
  if (/^(?:ну и шутка|хорошая шутка|вот это шутка|чӣ шӯхии хуб|шӯхии хуб)(?!\p{L})/iu.test(plain)) return `[giggling] ${plain}`;
  if (/^(?:ура|поздравляю|вот это здорово|офарин|табрик(?: мекунам)?|муборак)(?!\p{L})/iu.test(plain)) return `[delighted] ${plain}`;
  if (/^(?:фух|ну вот, (?:теперь )?вс[её] получилось|хайрият|худоро шукр)(?!\p{L})/iu.test(plain)) return `[exhales] ${plain}`;
  if (plain.endsWith("?") && /^(?:интересно|мне интересно|ҷолиб|ба ман ҷолиб аст)(?!\p{L})/iu.test(plain)) return `[curious] ${plain}`;
  if (/^(?:отлично|спасибо|рада помочь|приятно слышать|ташаккур|раҳмат|хушҳолам)(?!\p{L})/iu.test(plain)) return `[warmly] ${plain}`;
  // A short dash gives a deliberate beat without adding a second delivery direction.
  return plain.replace(/^(самое главное|вот что важно|муҳимаш|аз ҳама муҳим):\s*/iu, "$1 — ");
}
