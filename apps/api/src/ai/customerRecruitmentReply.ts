import { customerRecruitmentRequested } from "./customerAgentRecruitmentProtocol.js";

// Presentation of already validated staff text only. Do not synthesize working
// conditions, split monetary values/sentences, or turn a missing keyword match
// into a claim that the condition is absent. Unfamiliar layouts stay intact.
const aspects = [
  { question: /зарплат|оклад|оплат|платит|платят|заработ|доход|комисси|маош|даромад|музд/iu,
    paragraph: /зарплат|оклад|оплат|заработ|доход|комисси|маош|даромад|музд|фоиз|ҳаққи хизмат/iu },
  { question: /удал[её]н|дистанцион|из дома|фосилав|аз хона/iu,
    paragraph: /удал[её]н|дистанцион|очно|работа.*офис|фосилав|кор дар офис/iu },
  { question: /график|суббот|выходн|рӯзҳои кор|(?<!\p{L})шанбе(?!\p{L})/iu,
    paragraph: /график|понедельник|суббот|выходн|ҷадвал|(?<!\p{L})шанбе(?!\p{L})|пурравақт/iu },
  { question: /час[ыа]?\s+работ|соати кор|соатҳои кор/iu,
    paragraph: /час[ыа]?\s|соат/iu },
  { question: /где.*офис|адрес|как.*добраться|кадом.*(?:офис|идора)|суроға|куҷо/iu,
    paragraph: /адрес|улиц|ул\.|этаж|ориентир|суроға|кӯча|ошёна|нишон/iu },
  { question: /обязанност|чем.*заниматься|что.*делать|задач|вазифа|чӣ.*(?:кор|лозим)/iu,
    paragraph: /снимать|монтир|вести|задач|обязанност|нав[оа]рбардор|таҳрир|пешбурд|вазифа/iu },
  { question: /резюме|отклик|портфолио|как.*устроиться|опыт|таҷриба|муроҷиат|портфолио/iu,
    paragraph: /резюме|отклик|портфолио|опыт|таҷриба|муроҷиат|намуна/iu },
] as const;

/** Small relevant view, not a new source of truth. Keep each original paragraph
 * and every restriction within it. Cross-paragraph conditions remain complete. */
export function customerRecruitmentReplyDetails(details: string, inputText: string): string[] {
  const paragraphs = details.split(/\r?\n/u).map(value => value.trim()).filter(Boolean);
  if (paragraphs.length < 2 || /если|только после|при условии|в случае|агар|ба шарте/iu.test(details)) return paragraphs;
  const full = /(?:все|полные)\s+условия|подроб|муфассал|ҳамаи\s+шарт/iu.test(inputText);
  if (full) return paragraphs;
  const requested = aspects.filter(aspect => aspect.question.test(inputText));
  if (requested.length) {
    const selected = paragraphs.filter(paragraph => requested.some(aspect => aspect.paragraph.test(paragraph)));
    // Failure to classify staff text is not evidence of an unpublished fact.
    return selected.length ? selected : paragraphs;
  }
  // The first contact needs a short introduction. Full conditions remain in the
  // source and are available on the next specific/full-conditions question.
  if (customerRecruitmentRequested(inputText)) return paragraphs.slice(0, 2);
  return paragraphs;
}

export function containsRecruitmentExperienceInvitation(paragraphs: readonly string[]): boolean {
  // Any form of the invitation: "пришлите", "можете прислать", "присылайте", "отправьте", "резюме фиристед".
  return paragraphs.some(text => /(?:пришл\p{L}*|присл\p{L}*|присыл\p{L}*|отправ\p{L}*).*(?:резюме|расскажите о себе)|резюме\p{L}*\s+(?:ро\s+)?фирист\p{L}*|дар бораи худ.*нақл кун\p{L}*/iu.test(text));
}
