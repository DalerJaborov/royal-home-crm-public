import { describe, expect, it } from "vitest";
import { customerMutationCommandSchema } from "@royal-home/shared";
import { customerAgentToolDefinitions, CUSTOMER_AGENT_PUBLIC_TOOLS } from "../src/ai/customerAgentToolDefinitions.js";
import { managedGeminiFunctionDeclarations, assertManagedGeminiFunctionWire } from "../src/ai/geminiFunctionDeclarations.js";

describe("bound parametersJsonSchema Value wire", () => {
  it("preserves every actual public and mutation tool's WHOLE emitted schema without changing validators/input definitions", () => {
    const names = [...CUSTOMER_AGENT_PUBLIC_TOOLS, ...customerMutationCommandSchema.options.map(option => option.shape.name.value)];
    const definitions = customerAgentToolDefinitions(names), original = structuredClone(definitions);
    const wire = managedGeminiFunctionDeclarations(definitions);
    expect(wire).toHaveLength(definitions.length);
    for (let index = 0; index < wire.length; index++) {
      expect(wire[index].name).toBe(definitions[index].name);
      expect(wire[index].description).toBe(definitions[index].description);
      expect(wire[index].parametersJsonSchema).toEqual(definitions[index].parameters);
      expect(wire[index]).not.toHaveProperty("parameters");
    }
    expect(definitions).toEqual(original);
    expect(() => assertManagedGeminiFunctionWire([{ functionDeclarations: wire }])).not.toThrow();
    // Same original server validator still denies added model-supplied authority fields.
    expect(customerMutationCommandSchema.safeParse({ name: "request_callback", args: { topic: "Позвоните", clientId: "foreign" } }).success).toBe(false);
  });
  it("keeps strict zero-argument schema and all nested JSON keywords rather than dropping additionalProperties", () => {
    const parameters = { type: "object", additionalProperties: false, properties: { nested: { type: "object", additionalProperties: false,
      properties: { at: { type: "string", format: "date-time", pattern: "^20", minLength: 4 },
        amount: { anyOf: [{ type: "number", minimum: 0 }, { type: "string", enum: ["по запросу"] }] } }, required: ["at"] } }, required: ["nested"] };
    const definitions = [{ name: "bounded", description: "Synthetic nested schema", parameters },
      { name: "empty", description: "No args", parameters: { type: "object", properties: {}, additionalProperties: false } }];
    const wire = managedGeminiFunctionDeclarations(definitions);
    expect(wire[0].parametersJsonSchema).toEqual(parameters);
    expect(wire[1].parametersJsonSchema).toEqual(definitions[1].parameters);
    expect(() => assertManagedGeminiFunctionWire([{ functionDeclarations: wire }])).not.toThrow();
  });
  it("never accepts both declaration dialects or silently upgrades a legacy/malformed wire", () => {
    const declaration = { name: "empty", description: "No args", parameters: { type: "object", properties: {}, additionalProperties: false } };
    expect(() => managedGeminiFunctionDeclarations([{ ...declaration, parametersJsonSchema: declaration.parameters }])).toThrow();
    expect(() => assertManagedGeminiFunctionWire([{ functionDeclarations: [declaration] }])).toThrow();
    expect(() => managedGeminiFunctionDeclarations([{ ...declaration, parameters: { type: "object", unknown: undefined } }])).toThrow();
    expect(() => managedGeminiFunctionDeclarations([{ ...declaration, parameters: { type: "array", items: { type: "string" } } }])).toThrow();
    expect(() => managedGeminiFunctionDeclarations([declaration, declaration])).toThrow();
  });
});
