-- Singleton app-config table for client version control, cache
-- invalidation, and maintenance-mode flags.

CREATE TABLE app_config (
  id SMALLINT PRIMARY KEY DEFAULT 1,
  force_update_required BOOLEAN NOT NULL DEFAULT false,
  minimum_app_version TEXT,
  latest_app_version TEXT,
  store_url TEXT,
  clear_local_cache BOOLEAN NOT NULL DEFAULT false,
  cache_epoch INTEGER NOT NULL DEFAULT 0,
  catalog_version TEXT,
  maintenance_active BOOLEAN NOT NULL DEFAULT false,
  maintenance_message TEXT,
  maintenance_until TIMESTAMPTZ,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT app_config_singleton CHECK (id = 1)
);

INSERT INTO app_config (
  id,
  force_update_required,
  minimum_app_version,
  latest_app_version,
  store_url,
  clear_local_cache,
  cache_epoch,
  catalog_version,
  maintenance_active,
  maintenance_message,
  maintenance_until
) VALUES (
  1,
  false,
  '1.0.0',
  '1.0.0',
  'https://apps.example.com/vir-estimator',
  false,
  7,
  '2024.11.3',
  false,
  NULL,
  NULL
)
ON CONFLICT (id) DO NOTHING;
