/** Locators only; raw corpus stays outside Git. These are synthetic structural
 * companions, not complete machine graders for historical expectedBehavior. */
export const ASSERTION_ADAPTERS = [
  { id: "Д005", language: "ru", knownPhone: false, recovery: true },
  { id: "Д111", language: "tg", knownPhone: false, recovery: true },
  { id: "Д146", language: "tg", knownPhone: false, recovery: true },
  { id: "Д037", language: "tg", knownPhone: true },
  { id: "Д086", language: "ru", knownPhone: true },
  { id: "Д023", language: "tg", knownPhone: true },
  { id: "Д456", language: "tg", knownPhone: false },
  { id: "Д905", language: "tg", knownPhone: true },
  { id: "Д789", language: "tg", knownPhone: false },
  { id: "Д714", language: "ru", knownPhone: false },
  { id: "Д852", language: "tg", knownPhone: true, substring: true },
] as const;
export const SYNTHETIC_PHONE = "+992900000001";
