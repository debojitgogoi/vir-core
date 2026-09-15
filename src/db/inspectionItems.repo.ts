/**
 * Inspection line items and their three junction tables.
 *
 * Batch inserts run in a single transaction: the spec's array form exists so a
 * tablet can upload a whole walkaround at once, and half a walkaround landing
 * would be worse than none — the client cannot tell what survived without
 * re-reading the card.
 *
 * This module never throws AppError. A foreign-key violation surfaces as the
 * `pg` error and the service maps it, keeping the layering the rest of the
 * codebase follows.
 */

import { PoolClient } from "pg";
import { pool } from "./pool";
import { CustomFieldAnswer, FieldDefinition } from "../services/customFields";

export interface InspectionItemRow {
  id: string;
  job_card_id: string;
  main_view_id: string | null;
  subview_id: string | null;
  component_id: string | null;
  condition_rating: string | null;
  notes: string | null;
  custom_fields: CustomFieldAnswer[];
  display_order: number;
  client_uuid: string | null;
  damage_code_ids: string[];
  repair_code_ids: string[];
  created_by: string | null;
  created_at: Date;
  updated_at: Date;
}

/** The columns a client may set, in the order the insert lists them. */
export interface InsertInspectionItemInput {
  mainViewId: string | null;
  subviewId: string | null;
  componentId: string | null;
  conditionRating: string | null;
  notes: string | null;
  customFields: CustomFieldAnswer[];
  displayOrder: number;
  clientUuid: string | null;
  damageCodeIds: string[];
  repairCodeIds: string[];
}

/**
 * Columns an update may name. The service intersects its patch with this list,
 * so a hand-built patch cannot reach `id`, `job_card_id`, `client_uuid` or the
 * timestamps.
 */
export const PATCHABLE_ITEM_COLUMNS = [
  "main_view_id",
  "subview_id",
  "component_id",
  "condition_rating",
  "notes",
  "custom_fields",
  "display_order",
] as const;

/**
 * The junctions are gathered with LATERAL aggregates so one query returns the
 * whole item, and COALESCE turns "no rows" into an empty array rather than the
 * `[null]` a bare array_agg over an outer join would produce.
 *
 * The ORDER BY ends in `i.id` for the same reason signatures.repo.ts needed
 * it: rows inserted inside one transaction share `now()`, so display_order and
 * created_at together are still not a total order.
 */
const SELECT_ITEM = `
  SELECT i.*,
         COALESCE(d.ids, ARRAY[]::uuid[]) AS damage_code_ids,
         COALESCE(r.ids, ARRAY[]::uuid[]) AS repair_code_ids
    FROM inspection_items i
    LEFT JOIN LATERAL (
      SELECT array_agg(damage_code_id ORDER BY created_at, id) AS ids
        FROM inspection_item_damages WHERE inspection_item_id = i.id
    ) d ON true
    LEFT JOIN LATERAL (
      SELECT array_agg(repair_code_id ORDER BY created_at, id) AS ids
        FROM inspection_item_repairs WHERE inspection_item_id = i.id
    ) r ON true
`;

async function insertJunctions(
  client: PoolClient,
  itemId: string,
  damageCodeIds: string[],
  repairCodeIds: string[],
): Promise<void> {
  if (damageCodeIds.length > 0) {
    await client.query(
      `INSERT INTO inspection_item_damages (inspection_item_id, damage_code_id)
       SELECT $1, unnest($2::uuid[])`,
      [itemId, damageCodeIds],
    );
  }
  if (repairCodeIds.length > 0) {
    await client.query(
      `INSERT INTO inspection_item_repairs (inspection_item_id, repair_code_id)
       SELECT $1, unnest($2::uuid[])`,
      [itemId, repairCodeIds],
    );
  }
}

/**
 * Inserts every item and its codes in one transaction, then reads them back
 * with their junctions attached.
 *
 * @returns the rows in the order they were given, so a client can line the
 * results up against the batch it sent.
 */
export async function insertInspectionItems(
  jobCardId: string,
  items: InsertInspectionItemInput[],
  createdBy: string | null,
): Promise<InspectionItemRow[]> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    const ids: string[] = [];
    for (const item of items) {
      const { rows } = await client.query<{ id: string }>(
        `INSERT INTO inspection_items
           (job_card_id, main_view_id, subview_id, component_id, condition_rating,
            notes, custom_fields, display_order, client_uuid, created_by)
         VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8, $9, $10)
         RETURNING id`,
        [
          jobCardId,
          item.mainViewId,
          item.subviewId,
          item.componentId,
          item.conditionRating,
          item.notes,
          JSON.stringify(item.customFields),
          item.displayOrder,
          item.clientUuid,
          createdBy,
        ],
      );
      const id = rows[0].id;
      ids.push(id);
      await insertJunctions(client, id, item.damageCodeIds, item.repairCodeIds);
    }

    await client.query("COMMIT");

    // Read back outside the transaction: the junctions are now committed, and
    // the caller wants the same projection every other read returns.
    const rows = await findInspectionItemsByIds(ids);
    const byId = new Map(rows.map((row) => [row.id, row]));
    return ids.map((id) => byId.get(id)!);
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}

async function findInspectionItemsByIds(ids: string[]): Promise<InspectionItemRow[]> {
  if (ids.length === 0) return [];
  const { rows } = await pool.query<InspectionItemRow>(
    `${SELECT_ITEM} WHERE i.id = ANY($1::uuid[])`,
    [ids],
  );
  return rows;
}

export async function listInspectionItems(jobCardId: string): Promise<InspectionItemRow[]> {
  const { rows } = await pool.query<InspectionItemRow>(
    `${SELECT_ITEM}
      WHERE i.job_card_id = $1
      ORDER BY i.display_order, i.created_at, i.id`,
    [jobCardId],
  );
  return rows;
}

export async function findInspectionItem(itemId: string): Promise<InspectionItemRow | null> {
  const { rows } = await pool.query<InspectionItemRow>(`${SELECT_ITEM} WHERE i.id = $1`, [itemId]);
  return rows[0] ?? null;
}

export async function findInspectionItemByClientUuid(
  jobCardId: string,
  clientUuid: string,
): Promise<InspectionItemRow | null> {
  const { rows } = await pool.query<InspectionItemRow>(
    `${SELECT_ITEM} WHERE i.job_card_id = $1 AND i.client_uuid = $2`,
    [jobCardId, clientUuid],
  );
  return rows[0] ?? null;
}

/** The end of the card's current list, so an item with no display_order appends. */
export async function findMaxDisplayOrder(jobCardId: string): Promise<number> {
  const { rows } = await pool.query<{ max: number | null }>(
    "SELECT MAX(display_order) AS max FROM inspection_items WHERE job_card_id = $1",
    [jobCardId],
  );
  return rows[0].max ?? -1;
}

export interface UpdateInspectionItemJunctions {
  damageCodeIds?: string[];
  repairCodeIds?: string[];
}

/**
 * Updates the columns a patch names and replaces the junctions it names.
 *
 * The SET clause is built from key presence, never `COALESCE($n, col)`: that
 * pattern cannot express "set this to NULL", which is the bug the depot
 * repository still carries. An explicit null in the patch clears the column.
 *
 * When the patch names no columns but does name junctions, `updated_at` is
 * still moved — replacing an item's damage codes is a change to the item.
 */
export async function updateInspectionItem(
  itemId: string,
  patch: Record<string, unknown>,
  junctions: UpdateInspectionItemJunctions = {},
): Promise<InspectionItemRow | null> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    const sets: string[] = [];
    const values: unknown[] = [];

    for (const column of PATCHABLE_ITEM_COLUMNS) {
      if (!Object.prototype.hasOwnProperty.call(patch, column)) continue;
      const value = patch[column];
      values.push(column === "custom_fields" ? JSON.stringify(value) : value);
      sets.push(`${column} = $${values.length}${column === "custom_fields" ? "::jsonb" : ""}`);
    }

    // Always assign something so the BEFORE UPDATE trigger fires: an item
    // whose only change was its damage codes has still changed.
    if (sets.length === 0) sets.push("updated_at = updated_at");

    values.push(itemId);
    const { rowCount } = await client.query(
      `UPDATE inspection_items SET ${sets.join(", ")} WHERE id = $${values.length}`,
      values,
    );

    if (!rowCount) {
      await client.query("ROLLBACK");
      return null;
    }

    if (junctions.damageCodeIds) {
      await client.query("DELETE FROM inspection_item_damages WHERE inspection_item_id = $1", [
        itemId,
      ]);
    }
    if (junctions.repairCodeIds) {
      await client.query("DELETE FROM inspection_item_repairs WHERE inspection_item_id = $1", [
        itemId,
      ]);
    }
    await insertJunctions(
      client,
      itemId,
      junctions.damageCodeIds ?? [],
      junctions.repairCodeIds ?? [],
    );

    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }

  return findInspectionItem(itemId);
}

/** @returns true when a row was removed, false when there was none. */
export async function deleteInspectionItem(itemId: string): Promise<boolean> {
  const result = await pool.query("DELETE FROM inspection_items WHERE id = $1", [itemId]);
  return (result.rowCount ?? 0) > 0;
}

/**
 * The field definitions for a subview, each with its options attached.
 *
 * `json_agg` filtered on a non-null id, defaulted to an empty array: a field
 * with no options must come back as `[]` rather than `[null]`, because
 * `validateCustomFields` reads the array's length to decide whether the field
 * is option-backed at all.
 */
export async function findSubviewFieldDefinitions(
  subviewId: string,
): Promise<FieldDefinition[]> {
  const { rows } = await pool.query<FieldDefinition>(
    `SELECT sf.id,
            sf.field_name,
            sf.label,
            wt.name AS widget_type_name,
            COALESCE(
              json_agg(
                json_build_object('id', o.id, 'label_value', o.label_value)
                ORDER BY o.display_order, o.id
              ) FILTER (WHERE o.id IS NOT NULL),
              '[]'::json
            ) AS options
       FROM subview_fields sf
       JOIN widget_types wt ON wt.id = sf.widget_type_id
       LEFT JOIN subview_field_options o ON o.subview_field_id = sf.id
      WHERE sf.subview_id = $1
      GROUP BY sf.id, sf.field_name, sf.label, wt.name, sf.display_order
      ORDER BY sf.display_order, sf.id`,
    [subviewId],
  );
  return rows;
}

// --- Line-item media ------------------------------------------------------
//
// Mirrors the job-card equivalents in media.repo.ts, including its BIGINT
// conversion at this boundary: size_bytes reaches JavaScript as a string so
// that values beyond 2^53 survive, and every consumer would otherwise have to
// remember that.

export interface ItemMediaRaw {
  id: string;
  storage_key: string;
  checksum_sha256: string;
  content_type: string;
  size_bytes: string;
  original_filename: string | null;
  status: string;
  depot_id: string | null;
  uploaded_by: string | null;
  created_at: Date;
  updated_at: Date;
  display_order: number;
  attached_at: Date;
}

export type ItemMediaRow = Omit<ItemMediaRaw, "size_bytes"> & { size_bytes: number };

export interface InsertInspectionItemMediaInput {
  inspectionItemId: string;
  mediaAssetId: string;
  displayOrder: number;
  createdBy: string | null;
}

export async function insertInspectionItemMedia(
  input: InsertInspectionItemMediaInput,
): Promise<void> {
  await pool.query(
    `INSERT INTO inspection_item_media
       (inspection_item_id, media_asset_id, display_order, created_by)
     VALUES ($1, $2, $3, $4)`,
    [input.inspectionItemId, input.mediaAssetId, input.displayOrder, input.createdBy],
  );
}

export async function listInspectionItemMedia(itemId: string): Promise<ItemMediaRow[]> {
  const { rows } = await pool.query<ItemMediaRaw>(
    `SELECT a.*, l.display_order, l.created_at AS attached_at
       FROM inspection_item_media l
       JOIN media_assets a ON a.id = l.media_asset_id
      WHERE l.inspection_item_id = $1
      ORDER BY l.display_order, l.created_at, l.id`,
    [itemId],
  );
  return rows.map((raw) => ({ ...raw, size_bytes: Number(raw.size_bytes) }));
}

export async function findMaxItemMediaOrder(itemId: string): Promise<number> {
  const { rows } = await pool.query<{ max: number | null }>(
    "SELECT MAX(display_order) AS max FROM inspection_item_media WHERE inspection_item_id = $1",
    [itemId],
  );
  return rows[0].max ?? -1;
}

/** @returns true when a link was removed, false when there was none. */
export async function deleteInspectionItemMedia(
  itemId: string,
  mediaAssetId: string,
): Promise<boolean> {
  const result = await pool.query(
    "DELETE FROM inspection_item_media WHERE inspection_item_id = $1 AND media_asset_id = $2",
    [itemId, mediaAssetId],
  );
  return (result.rowCount ?? 0) > 0;
}
