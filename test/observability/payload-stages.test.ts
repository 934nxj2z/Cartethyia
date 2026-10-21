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

describe("payload budget order", () => {
  const base = {
    tenantId: "t1",
    requestId: "r1",
    tenantOptIn: true,
    scope: "tenant" as const,
    requestBody: null,
    responseBody: null,
  };
  // The reported symptom: a ~744 KiB client request and a ~55 KiB client
  // response, panels 2 and 3 blank. The client response was stored *twice* —
  // once as `client_response_body` and once as the legacy `response_body`
  // alias — and the alias was accounted second, ahead of both provider
  // stages. On a 1 MiB minimum budget the duplicate spent the remainder
  // before the provider panels were reached, so a request that did reach an
  // upstream reported no provider exchange at all.
  const big = (chars: number): string => "x".repeat(chars);

  test("the provider stages are funded before the legacy response alias", () => {
    // Measured against the reported shape on a 1 MiB minimum budget: a
    // 743,600-byte client request, a 55 KB client response stored twice, and
    // 200 KB provider bodies. The alias accounted second spends the remainder
    // before either provider stage is reached, so both read empty; accounted
    // last, the provider request survives.
    const record = buildPayloadRecord(
      {
        ...base,
        requestBody: big(743_600),
        responseBody: big(55_000),
        clientResponseBody: big(55_000),
        providerRequestBody: big(200_000),
        providerResponseBody: big(200_000),
      },
      new Date(),
      1_048_576,
    );
    expect(record.request_body).not.toBeNull();
    expect(record.provider_request_body).not.toBeNull();
    expect(record.stages & 2).toBe(2);
  });

  test("a truncated panel is marked, not silently blank", () => {
    const record = buildPayloadRecord(
      { ...base, requestBody: big(600), providerRequestBody: big(600) },
      new Date(),
      700,
    );
    const marker = record.provider_request_body as Record<string, unknown>;
    expect(marker._truncated).toBe(true);
    // A marker is not captured content: the stage must read uncaptured so the
    // Usage list does not tick a panel whose body was never kept.
    expect(record.stages & 2).toBe(0);
  });

  test("a panel that never carried a body is null, not marked truncated", () => {
    // The old form stamped the marker onto every null surface, so a request
    // that never reached an upstream claimed it had been truncated.
    const record = buildPayloadRecord({ ...base, requestBody: { a: 1 } });
    expect(record.provider_request_body).toBeNull();
    expect(record.provider_response_body).toBeNull();
    expect(record.response_body).toBeNull();
  });
});
