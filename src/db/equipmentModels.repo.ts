import {PoolClient} from "pg";
import {pool} from "./pool";
import {Manifest} from "../utils/manifest";

export interface EquipmentTypeModelRow {
  id: string;
  slug_id: string;
  equipment_type_id: string;
  version_number: number;
  is_active: boolean;
  manifest: Manifest;
  manifest_version: string;
  node_count: number;
  storage_key: string;
  original_filename: string;
  content_type: string;
  file_size_bytes: string;
  checksum_sha256: string;
  uploaded_by: string | null;
  created_at: Date;
  updated_at: Date;
}

export interface InsertModelParams {
  equipmentTypeId: string;
  slugId: string;
  manifest: Manifest;
  manifestVersion: string;
  nodeCount: number;
  storageKey: string;
  originalFilename: string;
  fileSizeBytes: number;
  checksumSha256: string;
  uploadedBy: string | null;
}

const MODEL_COLUMNS = `id, slug_id, equipment_type_id, version_number, is_active,
                       manifest, manifest_version, node_count, storage_key,
                       original_filename, content_type, file_size_bytes,
                       checksum_sha256, uploaded_by, created_at, updated_at`;

export async function getActiveModel(
  equipmentTypeId: string,
): Promise<EquipmentTypeModelRow | null> {
  const {rows} = await pool.query<EquipmentTypeModelRow>(
    `SELECT ${MODEL_COLUMNS}
     FROM equipment_type_models
     WHERE equipment_type_id = $1
       AND is_active = true`,
    [equipmentTypeId],
  );
  return rows[0] ?? null;
}

export async function getModelByVersion(
  equipmentTypeId: string,
  versionNumber: number,
): Promise<EquipmentTypeModelRow | null> {
  const {rows} = await pool.query<EquipmentTypeModelRow>(
    `SELECT ${MODEL_COLUMNS}
     FROM equipment_type_models
     WHERE equipment_type_id = $1
       AND version_number = $2`,
    [equipmentTypeId, versionNumber],
  );
  return rows[0] ?? null;
}

export async function getModelById(id: string): Promise<EquipmentTypeModelRow | null> {
  const {rows} = await pool.query<EquipmentTypeModelRow>(
    `SELECT ${MODEL_COLUMNS}
     FROM equipment_type_models
     WHERE id = $1`,
    [id],
  );
  return rows[0] ?? null;
}

/**
 * Insert a new model version and make it the active one.
 *
 * Runs in a single transaction that first locks the parent equipment_types row.
 * Two concurrent uploads for the same equipment type would otherwise both read
 * the same MAX(version_number) and collide on the unique constraint; the lock
 * serializes them so the second simply gets the next version.
 */
export async function insertModelVersion(
  params: InsertModelParams,
): Promise<EquipmentTypeModelRow> {
  const client: PoolClient = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT id FROM equipment_types WHERE id = $1 FOR UPDATE", [
      params.equipmentTypeId,
    ]);

    const {rows: versionRows} = await client.query<{ next_version: number }>(
      `SELECT COALESCE(MAX(version_number), 0) + 1 AS next_version
       FROM equipment_type_models
       WHERE equipment_type_id = $1`,
      [params.equipmentTypeId],
    );
    const nextVersion = versionRows[0].next_version;

    // Stand the previous active version down before inserting the new one —
    // ux_equipment_type_models_active permits only one active row per type.
    await client.query(
      `UPDATE equipment_type_models
       SET is_active = false
       WHERE equipment_type_id = $1
         AND is_active = true`,
      [params.equipmentTypeId],
    );

    const {rows} = await client.query<EquipmentTypeModelRow>(
      `INSERT INTO equipment_type_models
       (slug_id, equipment_type_id, version_number, is_active, manifest,
        manifest_version, node_count, storage_key, original_filename,
        file_size_bytes, checksum_sha256, uploaded_by)
       VALUES ($1, $2, $3, true, $4, $5, $6, $7, $8, $9, $10, $11)
           RETURNING ${MODEL_COLUMNS}`,
      [
        params.slugId,
        params.equipmentTypeId,
        nextVersion,
        JSON.stringify(params.manifest),
        params.manifestVersion,
        params.nodeCount,
        params.storageKey,
        params.originalFilename,
        params.fileSizeBytes,
        params.checksumSha256,
        params.uploadedBy,
      ],
    );

    await client.query("COMMIT");
    return rows[0];
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}

export async function slugIdExists(slugId: string): Promise<boolean> {
  const {rows} = await pool.query(
    "SELECT 1 FROM equipment_type_models WHERE slug_id = $1",
    [slugId],
  );
  return rows.length > 0;
}
