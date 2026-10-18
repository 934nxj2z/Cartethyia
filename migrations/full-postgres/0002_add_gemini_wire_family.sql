-- Adds `gemini` to the wire_family enum.
--
-- Factory serves Gemini models on a native generateContent wire
-- (`/api/llm/g/v1/generate`), not the chat wire, so a Gemini id routed onto
-- `chat` posts to an endpoint that does not serve it. The catalog needs a wire
-- family that says so.
--
-- PostgreSQL has no `ADD VALUE IF NOT EXISTS`, so the addition is guarded by a
-- catalog check to keep the file idempotent: a re-run (or a database that
-- already has the label from a newer baseline) must not fail startup.
--
-- Note: in PostgreSQL 12+ a value added by `ALTER TYPE` cannot be *used* in the
-- same transaction that added it. This migration only adds the label, so the
-- restriction does not apply here — but a later migration that inserts
-- `gemini` rows must do so in its own migration file.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_enum e
    JOIN pg_type t ON t.oid = e.enumtypid
    JOIN pg_namespace n ON n.oid = t.typnamespace
    WHERE n.nspname = 'public'
      AND t.typname = 'wire_family'
      AND e.enumlabel = 'gemini'
  ) THEN
    ALTER TYPE "public"."wire_family" ADD VALUE 'gemini';
  END IF;
END $$;
