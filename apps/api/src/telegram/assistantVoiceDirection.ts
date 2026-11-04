/** Only these cues are supplied to ElevenLabs. They never appear in chat text. */
export function directAssistantVoice(speech: string): string {
  const plain = speech
    .replace(/\[[a-z][a-z ,'-]{0,65}\]/giu, " ")
    .replace(/[[\]]/gu, "")
    .replace(/\s{2,}/gu, " ").trim();
  if (!plain) return "";
  const greeting = /^(?:коллеги,? привет|всем привет|здравствуй(?:те)?|добрый (?:день|вечер)|добро пожаловать|привет|салом|ассалому алейкум|хуш омадед)(?=[\s.!?,]|$)/iu;
  if (!greeting.test(plain)) {
    if (/^(?:отлично|спасибо|ташаккур|раҳмат)(?=[\s.!?,]|$)/iu.test(plain)) return `[warmly] ${plain}`;
    return plain;
  }
  const boundary = /^(.{6,105}?[.!?]) (.+)$/u.exec(plain);
  if (!boundary) return `[warmly] ${plain}`;
  const [, first, rest] = boundary;
  // One relaxed breath before a short follow-up question; facts retain their own phrasing.
  const transition = rest.length <= 75 && rest.endsWith("?") && !/\p{N}/u.test(rest) ? "[exhales]" : "[pause]";
  return `[warmly] ${first} ${transition} ${rest}`;
}
