/**
 * A tool definition may arrive in either spelling, on either surface.
 *
 * Chat writes `{"type":"function","function":{"name","parameters"}}`; Responses
 * writes the flat `{"type":"function","name","parameters"}`. Both spellings
 * reach both surfaces in the wild, and each dialect's schema lookup used to
 * demand only its own:
 *
 * - On Responses, a Chat-shaped tool had no top-level `parameters`, so the
 *   lookup fell through to `schema = item` and shipped the *whole tool object*
 *   upstream as the parameter schema — CodeBuddy answered 400
 *   `invalid_function_parameters` (11129), and the media tools in Model Lab
 *   simply stopped working.
 * - On Chat, a flat tool produced an empty schema and was rejected outright.
 *
 * These assert the schema that actually comes out, which is what reaches the
 * upstream wire.
 */
import { describe, expect, test } from "bun:test";
import { parseToolDefinition } from "../../src/transport/surface/dialects";

const schema = {
  type: "object",
  properties: { prompt: { type: "string" } },
  required: ["prompt"],
};

const flat = { type: "function", name: "generate_image", description: "Generate.", parameters: schema };
const nested = { type: "function", function: { name: "generate_image", description: "Generate.", parameters: schema } };

describe("parseToolDefinition — either spelling on either surface", () => {
  test("responses reads its own flat spelling", () => {
    const tool = parseToolDefinition(flat, "responses");
    expect(tool?.name).toBe("generate_image");
    expect(tool?.jsonSchema).toEqual(schema);
  });

  test("responses also reads the chat-shaped envelope", () => {
    // The regression that broke Model Lab's media tools.
    const tool = parseToolDefinition(nested, "responses");
    expect(tool?.name).toBe("generate_image");
    expect(tool?.jsonSchema).toEqual(schema);
  });

  test("chat reads its own envelope", () => {
    const tool = parseToolDefinition(nested, "chat");
    expect(tool?.name).toBe("generate_image");
    expect(tool?.jsonSchema).toEqual(schema);
  });

  test("chat also reads the flat responses spelling", () => {
    const tool = parseToolDefinition(flat, "chat");
    expect(tool?.name).toBe("generate_image");
    expect(tool?.jsonSchema).toEqual(schema);
  });

  test("a schema is never the whole tool object", () => {
    // The shape that reached the upstream as `parameters`.
    for (const dialect of ["chat", "responses"] as const) {
      const tool = parseToolDefinition(nested, dialect);
      expect(tool?.jsonSchema).not.toHaveProperty("type", "function");
      expect(tool?.jsonSchema).not.toHaveProperty("function");
    }
  });

  test("a hosted tool with no schema is still a tool", () => {
    const tool = parseToolDefinition({ type: "web_search" }, "responses");
    expect(tool?.name).toBe("web_search");
  });
});
