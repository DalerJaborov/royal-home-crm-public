/** The ONE rule of a link in a customer reply (review #225 N1, 17.11.2026): the company switch «бот может отправлять ссылки»
 * (and lead-only mode) decides, whoever builds the text — the renderer of the model path and the CRM video answer alike.
 * `undefined` keeps the renderer's historical meaning (a value written before the switch existed allows). */
export function customerReplyLink<T extends string>(link: T | null | undefined, linksAllowed: boolean | undefined): T | null {
  return linksAllowed === false || !link ? null : link;
}
