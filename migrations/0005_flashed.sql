-- Migration number: 0005 	 2026-07-13
-- Flash becomes an explicit per-attempt flag instead of being derived from
-- "first attempt was a send". Backfill preserves flashes shown under the old rule.
-- Numbered 0005 to leave 0004 for the photo-gallery branch in flight.
ALTER TABLE attempts ADD COLUMN flashed INTEGER NOT NULL DEFAULT 0;

UPDATE attempts
SET flashed = 1
WHERE result = 'send'
  AND id IN (
    SELECT id FROM (
      SELECT id,
             ROW_NUMBER() OVER (
               PARTITION BY route_id
               ORDER BY attempted_on ASC, created_at ASC
             ) AS rn
      FROM attempts
    )
    WHERE rn = 1
  );
