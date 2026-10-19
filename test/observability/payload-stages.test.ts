import { describe, expect, test } from "bun:test";
import { buildPayloadRecord } from "../../src/observability/payload-capture";

/**
 * Presence per payload stage, as the Usage list reads it.
 *
 * The list shows one icon per drawer panel — request, provider request,
 * provider response, client response — and must not have to inflate a frame
 * per row to know which panels have content. `stages` carries that, and this
 * pins the bit assignment: a bit moved here silently re-colours every icon.
 */
describe("payload stage presence", () => {
  const base = {
    tenantId: "t1",
    requestId: "r1",
    tenantOptIn: true,
    scope: "tenant" as const,
    requestBody: null,
    responseBody: null,
  };

  test("every stage present sets all four bits", () => {
    const record = buildPayloadRecord({
      ...base,
      requestBody: { a: 1 },
      responseBody: { b: 2 },
      clientResponseBody: { c: 3 },
      providerRequestBody: { d: 4 },
      providerResponseBody: { e: 5 },
    });
    expect(record.stages).toBe(15);
  });

  test("no bodies sets no bits", () => {
    const record = buildPayloadRecord({ ...base });
    expect(record.stages).toBe(0);
  });

  test("a request that never reached the upstream keeps only its own bit", () => {
    // The case the icons exist for: a failure before dispatch has a client
    // request and nothing else.
    const record = buildPayloadRecord({ ...base, requestBody: { a: 1 } });
    expect(record.stages).toBe(1);
  });

  test("the legacy response alias counts as the client response", () => {
    // `response_body` is the pre-rename spelling of `client_response_body`;
    // it names the same panel, so it must not read as an uncaptured one.
    const record = buildPayloadRecord({ ...base, responseBody: { b: 2 } });
    expect(record.stages).toBe(8);
  });

  test("metadata capture keeps only the provider request", () => {
    const record = buildPayloadRecord({ ...base, providerRequestBody: { d: 4 } });
    expect(record.stages).toBe(2);
  });
});
