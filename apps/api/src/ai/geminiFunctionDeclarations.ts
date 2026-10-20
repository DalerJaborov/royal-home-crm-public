import { z } from "zod";

export const GEMINI_FUNCTION_DECLARATION_PROTOCOL = "parameters-json-schema-value-v1" as const;
const name = z.string().regex(/^[A-Za-z_][A-Za-z0-9_.:-]{0,63}$/);
// Preserve the WHOLE existing emitted JSON Schema, including nested boolean
// additionalProperties, regex/format/enum/required/limits. No stripping, recursive
// conversion into Google's narrower Schema message, or caller-selected dialect.
const objectSchema = z.record(z.string(), z.json()).refine(value => value.type === "object");
const inputDeclaration = z.object({ name, description: z.string().min(1).max(8000),
  parameters: objectSchema.optional() }).strict();
const wireDeclaration = z.object({ name, description: z.string().min(1).max(8000),
  parametersJsonSchema: objectSchema.optional() }).strict();

/** Only call for a genuine BOUND count profile that selected the closed protocol.
 * Internal tool API keeps parameters; legacy/unbound wire remains unchanged.
 * This serializer never weakens the real server-side shared Zod validation. */
export function managedGeminiFunctionDeclarations(raw: unknown) {
  const declarations = z.array(inputDeclaration).max(32).parse(raw);
  if (new Set(declarations.map(item => item.name)).size !== declarations.length) throw new TypeError("Duplicate managed function declaration");
  return declarations.map(({ name, description, parameters }) => ({ name, description,
    ...(parameters === undefined ? {} : { parametersJsonSchema: parameters }) }));
}

/** Exact selected dialect is also checked before count I/O. Empty tools[] is a
 * valid no-function request; a mixed/legacy Schema declaration is never silently
 * upgraded, stripped, or recounted under a different body after the witness. */
export function assertManagedGeminiFunctionWire(raw: unknown): void {
  const groups = z.array(z.object({ functionDeclarations: z.array(wireDeclaration).max(32) }).strict()).max(1).parse(raw);
  const names = groups.flatMap(group => group.functionDeclarations.map(item => item.name));
  if (new Set(names).size !== names.length) throw new TypeError("Duplicate managed function declaration");
}
