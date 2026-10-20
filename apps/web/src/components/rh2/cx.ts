/** Склейка имён классов без пустот: `cx("pill", false, "soft")` → "pill soft". */
export function cx(...parts: Array<string | false | null | undefined>): string {
  return parts.filter(Boolean).join(" ");
}
