-- Migration number: 0006 	 2026-07-16
ALTER TABLE route_images ADD COLUMN drawings TEXT NOT NULL DEFAULT '[]';
