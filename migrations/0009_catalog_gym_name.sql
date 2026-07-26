-- The gym's display name as the source reports it, so the app can offer a
-- readable catalog picker ("Movement Boulder") instead of asking the user to
-- know KAYA's numeric gym id.
--
-- Additive only, same rule as 0008: no table rebuild.

ALTER TABLE gym_catalog ADD COLUMN source_gym_name TEXT NOT NULL DEFAULT '';
