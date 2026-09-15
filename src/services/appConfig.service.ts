import { AppError } from "../middleware/errors";
import { AppConfigDto } from "../types";
import { AppConfigRow, getAppConfig } from "../db/appConfig.repo";

function toAppConfigDto(row: AppConfigRow): AppConfigDto {
  return {
    force_update_required: row.force_update_required,
    minimum_app_version: row.minimum_app_version,
    latest_app_version: row.latest_app_version,
    store_url: row.store_url,
    clear_local_cache: row.clear_local_cache,
    cache_epoch: row.cache_epoch,
    catalog_version: row.catalog_version,
    maintenance: {
      active: row.maintenance_active,
      message: row.maintenance_message,
      until: row.maintenance_until ? row.maintenance_until.toISOString() : null,
    },
  };
}

export async function getAppConfigDto(): Promise<AppConfigDto> {
  const row = await getAppConfig();
  if (!row) throw new AppError(500, "App config is not initialized");
  return toAppConfigDto(row);
}
