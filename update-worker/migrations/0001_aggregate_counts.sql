-- One row per asset/category/day. No request records or client identifiers.
CREATE TABLE IF NOT EXISTS request_counts (
  day TEXT NOT NULL,
  asset_key TEXT NOT NULL,
  app_version TEXT NOT NULL,
  platform TEXT NOT NULL,
  architecture TEXT NOT NULL,
  asset_kind TEXT NOT NULL CHECK (asset_kind IN ('package', 'manifest')),
  request_kind TEXT NOT NULL CHECK (request_kind IN ('full', 'range', 'head')),
  response_status INTEGER NOT NULL,
  release_published_at TEXT NOT NULL,
  request_count INTEGER NOT NULL DEFAULT 0 CHECK (request_count >= 0),
  last_seen_at TEXT NOT NULL,
  PRIMARY KEY (day, asset_key, app_version, request_kind, response_status)
);
