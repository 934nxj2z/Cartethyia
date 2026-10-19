/**
 * The Command Code envelope and identity headers, against what its own client
 * sends.
 *
 * Three things were wrong, and each was invisible because the upstream still
 * answered:
 *
 *   * Tools omitted `type: "function"`. The reference client sends it on every
 *     tool, and a tool without it is not recognised as callable.
 *
 *   * `taste` and `skills` were absent and `memory` was `""`. The client sends
 *     all three as `null`, and the envelope is validated, so an absent field is
 *     not the same as a null one.
 *
 *   * `config.environment` was `""`. The client reports the real runtime; a
 *     blank attribution field is indistinguishable from one never filled in.
 *
 * Headers: `x-cli-environment` was `cli` rather than `production`, and
 * `x-project-slug` / `x-taste-learning` / `User-Agent` were missing entirely.
 */
import { describe, expect, test } from "bun:test";
import { buildRequest, geminiSafeSchema, headers } from "../../src/providers/integrations/commandcode/commandcode";
import type { CanonicalRequest } from "../../src/protocol/canonical-model";

const REQUEST: CanonicalRequest = {
  model: "xiaomi/mimo-v2.6-flash",
  messages: [{ role: "user", content: [{ kind: "text", text: "hi" }] }],
  generation_controls: {},
  stream: false,
  source_surface: "chat",
};

type CommandCodeTool = {
  readonly name: string;
  readonly description: string | undefined;
  readonly jsonSchema: unknown;
};

function envelope(tools: readonly CommandCodeTool[] = []) {
  return buildRequest(
    "xiaomi/mimo-v2.6-flash",
    {
      ...REQUEST,
      tools: [...tools],
      maxOutputTokens: null,
      temperature: null,
      topP: null,
      reasoningEffort: null,
    },
    "11111111-1111-4111-8111-111111111111",
  );
}

describe("commandcode envelope", () => {
  test("a tool carries type: function", () => {
    const body = envelope([
      { name: "read", description: "read a file", jsonSchema: { type: "object" } },
    ]);
    const params = body["params"] as Record<string, unknown>;
    const tools = params["tools"] as readonly Record<string, unknown>[];
    expect(tools).toHaveLength(1);
    expect(tools[0]?.["type"]).toBe("function");
    expect(tools[0]?.["input_schema"]).toEqual({ type: "object" });
  });

  test("memory, taste and skills are null, not empty or absent", () => {
    const body = envelope();
    expect(body["memory"]).toBeNull();
    expect("taste" in body).toBe(true);
    expect(body["taste"]).toBeNull();
    expect("skills" in body).toBe(true);
    expect(body["skills"]).toBeNull();
  });

  test("config.environment reports the real runtime", () => {
    const body = envelope();
    const config = body["config"] as Record<string, unknown>;
    expect(config["environment"]).toBe(
      `${process.platform}-${process.arch}, Node.js ${process.version}`,
    );
  });

  test("the envelope keeps the fields the upstream validates", () => {
    // Every one of these was named by the API's own validation errors.
    const config = envelope()["config"] as Record<string, unknown>;
    for (const key of [
      "workingDir",
      "date",
      "environment",
      "structure",
      "isGitRepo",
      "currentBranch",
      "mainBranch",
      "gitStatus",
      "recentCommits",
    ]) {
      expect(key in config).toBe(true);
    }
  });
});

describe("commandcode identity headers", () => {
  test("the environment is production, not cli", async () => {
    expect((await headers("s1", "tok"))["x-cli-environment"]).toBe("production");
  });

  test("attribution headers the client always sends are present", async () => {
    const h = await headers("s1", "tok");
    expect(h["x-taste-learning"]).toBe("true");
    expect(h["x-project-slug"]).toBeTruthy();
    expect(h["user-agent"]).toBe("cli");
    expect(h["x-command-code-version"]).toBeTruthy();
  });

  test("x-session-id is sent only when a session exists", async () => {
    // The client omits it rather than inventing one; a value minted per request
    // would attribute every call to a different session.
    expect((await headers("s1", "tok"))["x-session-id"]).toBe("s1");
    expect("x-session-id" in (await headers("", "tok"))).toBe(false);
  });

  test("the credential is the bearer", async () => {
    expect((await headers("s1", "tok"))["authorization"]).toBe("Bearer tok");
  });
});

describe("gemini-safe tool schema", () => {
  test("a nullable type array becomes one type plus nullable", () => {
    // Vertex rejects the gateway's `any_of with sibling fields`, which is what
    // a nullable type array becomes.
    expect(geminiSafeSchema({ type: ["string", "null"] })).toEqual({
      type: "string",
      nullable: true,
    });
  });

  test("a genuine multi-type union is left alone", () => {
    // Only the nullable spelling is the problem; a real union is data.
    expect(geminiSafeSchema({ type: ["string", "number"] })).toEqual({
      type: ["string", "number"],
    });
  });

  test("a null default is dropped", () => {
    expect(geminiSafeSchema({ type: "string", default: null })).toEqual({ type: "string" });
  });

  test("nested properties are rewritten too", () => {
    expect(
      geminiSafeSchema({
        type: "object",
        properties: { name: { type: ["string", "null"] } },
      }),
    ).toEqual({
      type: "object",
      properties: { name: { type: "string", nullable: true } },
    });
  });
});
