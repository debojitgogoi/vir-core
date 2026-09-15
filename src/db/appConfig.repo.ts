import { pool } from "./pool";

export interface AppConfigRow {
  id: number;
  force_update_required: boolean;
  minimum_app_version: string | null;
  latest_app_version: string | null;
  store_url: string | null;
  clear_local_cache: boolean;
  cache_epoch: number;
  catalog_version: string | null;
  maintenance_active: boolean;
  maintenance_message: string | null;
  maintenance_until: Date | null;
  updated_at: Date;
}

export async function getAppConfig(): Promise<AppConfigRow | null> {
  const { rows } = await pool.query<AppConfigRow>(
    "SELECT * FROM app_config WHERE id = 1",
  );
  return rows[0] ?? null;
}
