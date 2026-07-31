-- When the climb was last set, as the source reports it (KAYA's `date_updated`).
-- Stored as the ISO string it arrives as, which sorts correctly as text.
--
-- Not a guaranteed set date — a setter editing a grade would bump it too — but
-- it is setter-driven, not activity-driven: climbs with months-old values still
-- have recent ascents, and whole walls share a single value after a reset.
-- Better than our own first_seen_at, which only records when syncing began.
--
-- Additive only, same rule as 0008 and 0009: no table rebuild.

ALTER TABLE gym_catalog ADD COLUMN source_updated_at TEXT NOT NULL DEFAULT '';
