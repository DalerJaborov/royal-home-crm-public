export type WizardNumberKind = "decimal" | "integer" | "signedInteger" | "money";

/** Preserve a pasted fractional integer so validation can explain it, rather than turning 1.5 into 15. */
export function normalizeWizardNumber(raw: string, kind: WizardNumberKind): string {
  if (kind === "money") return raw.replace(/\D/g, "");
  const signed = raw.trimStart().replace(/−/g, "-");
  const negative = kind === "signedInteger" && signed.startsWith("-");
  let value = signed.replace(/,/g, ".").replace(/[^\d.]/g, "");
  const dot = value.indexOf(".");
  if (dot !== -1) value = value.slice(0, dot + 1) + value.slice(dot + 1).replace(/\./g, "");
  return negative ? `-${value}` : value;
}
