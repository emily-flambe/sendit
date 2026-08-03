INSERT OR REPLACE INTO gym_catalog (
  id,
  source,
  source_gym_id,
  source_gym_name,
  external_id,
  slug,
  grade,
  color,
  wall,
  discipline,
  rating,
  ascent_count,
  is_closed,
  first_seen_at,
  last_seen_at,
  removed_at,
  source_updated_at
) VALUES
  ('kaya:e2e-blue-v4', 'kaya', 'e2e-211', 'E2E Movement', 'e2e-blue-v4', '', 'v4', 'blue', 'Blue V4 Wall', 'boulder', NULL, 0, 0, 1, 1, NULL, '2026-07-05T12:00:00.000Z'),
  ('kaya:e2e-blue-v5', 'kaya', 'e2e-211', 'E2E Movement', 'e2e-blue-v5', '', 'v5', 'blue', 'Blue V5 Wall', 'boulder', NULL, 0, 0, 1, 1, NULL, '2026-07-04T12:00:00.000Z'),
  ('kaya:e2e-red-v4', 'kaya', 'e2e-211', 'E2E Movement', 'e2e-red-v4', '', 'v4', 'red', 'Red V4 Wall', 'boulder', NULL, 0, 0, 1, 1, NULL, '2026-07-03T12:00:00.000Z'),
  ('kaya:e2e-red-v5', 'kaya', 'e2e-211', 'E2E Movement', 'e2e-red-v5', '', 'v5', 'red', 'Red V5 Wall', 'boulder', NULL, 0, 0, 1, 1, NULL, '2026-07-02T12:00:00.000Z'),
  ('kaya:e2e-rope-blue-v4', 'kaya', 'e2e-211', 'E2E Movement', 'e2e-rope-blue-v4', '', 'v4', 'blue', 'Rope Wall', 'route', NULL, 0, 0, 1, 1, NULL, '2026-07-01T12:00:00.000Z');
