-- Batches, result bookkeeping and client API keys.

-- Position of an item inside its batch body; lets an open batch be rebuilt byte for byte.
ALTER TABLE emitted_readings ADD COLUMN batch_position int CHECK (batch_position >= 0);
ALTER TABLE emitted_readings
  ADD CONSTRAINT emitted_batch_pair_chk CHECK ((batch_id IS NULL) = (batch_position IS NULL));
CREATE UNIQUE INDEX emitted_batch_position_uq ON emitted_readings (batch_id, batch_position)
  WHERE batch_id IS NOT NULL;

-- A result posted twice must not act twice: remember what was posted and what we answered.
ALTER TABLE batches
  ADD COLUMN result_digest   text,
  ADD COLUMN result_response jsonb;

CREATE TABLE api_clients (
  id         bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  name       text NOT NULL UNIQUE CHECK (length(name) BETWEEN 1 AND 100),
  key_hash   text NOT NULL UNIQUE,
  created_at timestamptz NOT NULL DEFAULT now(),
  revoked_at timestamptz
);
