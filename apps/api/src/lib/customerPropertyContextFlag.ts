/** Independent rollout switch. No settings/network work before admission. */
export function customerPropertyContextEnabled(): boolean {
  return /^(?:1|true)$/i.test(process.env.BOT_PROPERTY_CONTEXT_ENABLED ?? "");
}
