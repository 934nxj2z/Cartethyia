-- Which payload stages were captured for a request, as a bitmask.
--
-- The detail drawer shows four panels (client request, provider request,
-- provider response, client response), and the Usage list shows one icon per
-- panel. Reading the frame to learn which stages exist costs an inflate per
-- row, so the writer records presence here at capture time and the list reads
-- it with the indexed row it already fetches.
--
-- Bit 0 (1) = request_body, bit 1 (2) = provider_request_body,
-- bit 2 (4) = provider_response_body, bit 3 (8) = client_response_body.
-- `response_body` is the legacy alias of the client response and is not
-- tracked: it never names a stage the other four do not.
--
-- Nullable with no default: NULL means the row predates this column, and the
-- list renders every icon greyed — an old row never observed presence, so
-- inventing it would be a claim.
ALTER TABLE "telemetry_payloads"
  ADD COLUMN "stages" integer;
