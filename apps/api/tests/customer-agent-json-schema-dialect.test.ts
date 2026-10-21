import { describe, expect, it } from "vitest";
import { customerMutationCommandSchema, customerPublicToolParameters } from "@royal-home/shared";
import { customerAgentToolDefinitions, CUSTOMER_AGENT_PUBLIC_TOOLS } from "../src/ai/customerAgentToolDefinitions.js";
import { managedGeminiFunctionDeclarations } from "../src/ai/geminiFunctionDeclarations.js";

function assertJsonSchemaBounds(value: unknown): void {
  if (Array.isArray(value)) { for (const item of value) assertJsonSchemaBounds(item); return; }
  if (value === null || typeof value !== "object") return;
  for (const [name, item] of Object.entries(value)) {
    if (name === "exclusiveMinimum" || name === "exclusiveMaximum") {
      expect(typeof item).toBe("number"); expect(Number.isFinite(item)).toBe(true);
    }
    expect(name).not.toBe("nullable");
    assertJsonSchemaBounds(item);
  }
}
describe("managed customer declarations emit JSON Schema, not OAS3", () => {
  it("emits the exact fourteen current tools with numeric exclusive bounds and preserves whole schemas on Value wire", () => {
    const names = [...CUSTOMER_AGENT_PUBLIC_TOOLS, ...customerMutationCommandSchema.options.map(item => item.shape.name.value)];
    const definitions = customerAgentToolDefinitions(names);
    expect(definitions.map(item => item.name).sort()).toEqual([
      "ask_owner", "book_showing", "cancel_showing", "get_agency_contact", "get_company_information", "get_company_policy",
      "get_open_vacancies", "get_property_facts", "request_callback", "request_handover", "reschedule_showing", "save_contact", "save_job_application", "search_public_properties",
    ]);
    expect(new Set(definitions.map(item => item.name)).size).toBe(14);
    for (const definition of definitions) {
      assertJsonSchemaBounds(definition.parameters);
      expect(definition.parameters).toMatchObject({ type: "object", additionalProperties: false });
      if (definition.name !== "get_agency_contact") {
        expect(definition.parameters.$schema).toBe("https://json-schema.org/draft/2020-12/schema");
      }
    }
    const wire = managedGeminiFunctionDeclarations(definitions);
    expect(wire.map(item => item.parametersJsonSchema)).toEqual(definitions.map(item => item.parameters));
    expect(wire.every(item => !("parameters" in item))).toBe(true);
  });
  it("retains the actual positive integer booking boundary, strict fields and datetime format", () => {
    const booking = customerAgentToolDefinitions(["book_showing"])[0].parameters;
    expect(booking).toMatchObject({ type: "object", required: ["propertyShortId", "at"], additionalProperties: false,
      properties: { propertyShortId: { type: "integer", exclusiveMinimum: 0 }, at: { type: "string", format: "date-time" } } });
    expect(customerMutationCommandSchema.safeParse({ name: "book_showing", args: { propertyShortId: 0, at: "2026-10-16T10:00:00+05:00" } }).success).toBe(false);
    expect(customerMutationCommandSchema.safeParse({ name: "book_showing", args: { propertyShortId: 1.5, at: "2026-10-16T10:00:00+05:00" } }).success).toBe(false);
    expect(customerMutationCommandSchema.safeParse({ name: "book_showing", args: { propertyShortId: 1, at: "2026-10-16T10:00:00+05:00", clientId: "foreign" } }).success).toBe(false);
    expect(customerMutationCommandSchema.safeParse({ name: "book_showing", args: { propertyShortId: 1, at: "2026-10-16T10:00:00+05:00" } }).success).toBe(true);
  });
  it("keeps the legacy public registry default while managed property facts explicitly select JSON Schema", () => {
    expect(customerPublicToolParameters()).not.toHaveProperty("$schema");
    expect(customerPublicToolParameters()).toEqual(customerPublicToolParameters("openapi-3.0"));
    const schema = customerAgentToolDefinitions(["get_property_facts"])[0].parameters;
    expect(schema).toEqual(customerPublicToolParameters("draft-2020-12"));
    expect(schema).toMatchObject({ properties: { kinds: { type: "array", minItems: 1, maxItems: 5,
      items: { type: "string", enum: ["price", "address", "builder", "characteristics", "availability"] } } }, required: ["kinds"], additionalProperties: false });
  });
});
