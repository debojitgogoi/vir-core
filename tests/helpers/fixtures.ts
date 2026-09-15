import crypto from "node:crypto";
import { pool } from "../../src/db/pool";
import { generateJobNumber } from "../../src/utils/jobNumber";

/**
 * Rows the job-card tests need to exist before a card can reference them.
 *
 * Names and codes are generated rather than literal: `equipment_categories`
 * and `equipment_types` are reference data that `resetDb` does not truncate,
 * and both carry UNIQUE constraints, so a fixed fixture name collides on the
 * second test in a file.
 */

export async function seedDepot(): Promise<string> {
  const { rows } = await pool.query<{ id: string }>(
    `INSERT INTO depots (slug_id, code, name)
     VALUES (generate_slug_id(8), 'D' || generate_slug_id(7), 'Fixture depot')
     RETURNING id`,
  );
  return rows[0].id;
}

export async function seedEquipmentType(): Promise<string> {
  const { rows } = await pool.query<{ id: string }>(
    `WITH category AS (
       INSERT INTO equipment_categories (name, slug_id)
       VALUES ('Cat-' || generate_slug_id(8), generate_slug_id(8))
       RETURNING id
     )
     INSERT INTO equipment_types (equipment_category_id, name, slug_id)
     SELECT id, 'Type-' || generate_slug_id(8), generate_slug_id(8) FROM category
     RETURNING id`,
  );
  return rows[0].id;
}

/**
 * A media asset row, PENDING by default. `checksum` defaults to a distinct
 * value per call so two fixtures never collide on content addressing.
 */
export async function seedMediaAsset(
  depotId: string | null,
  overrides: {
    status?: "PENDING" | "READY";
    contentType?: string;
    sizeBytes?: number;
    checksum?: string;
    storageKey?: string;
  } = {},
): Promise<string> {
  const status = overrides.status ?? "PENDING";
  const checksum = overrides.checksum ?? crypto.randomBytes(32).toString("hex");
  const storageKey =
    overrides.storageKey ?? (status === "READY" ? `media/${checksum.slice(0, 2)}/${checksum}.jpg` : "");

  const { rows } = await pool.query<{ id: string }>(
    `INSERT INTO media_assets
       (storage_key, checksum_sha256, content_type, size_bytes, status, depot_id)
     VALUES ($1, $2, $3, $4, $5, $6)
     RETURNING id`,
    [
      storageKey,
      checksum,
      overrides.contentType ?? "image/jpeg",
      overrides.sizeBytes ?? 1024,
      status,
      depotId,
    ],
  );
  return rows[0].id;
}

/** Makes `userId` the active member of `depotId`. */
export async function addDepotMember(depotId: string, userId: string): Promise<void> {
  await pool.query(
    `INSERT INTO depot_members (depot_id, user_id, is_active) VALUES ($1, $2, true)`,
    [depotId, userId],
  );
}

/**
 * A minimal valid DRAFT card — enough to hang a signature or media off.
 * `customer_name` and `driver_name` are populated because they are part of
 * what a signature receipt covers, so a test that edits one to invalidate a
 * receipt has something to edit.
 */
/**
 * Columns `seedJobCard` fills unless the caller says otherwise, and what it
 * fills them with. A key present in `values` — **including an explicit null** —
 * wins over its default, which is what lets a submission test build a card
 * that is deliberately incomplete.
 */
const JOB_CARD_DEFAULTS: Record<string, unknown> = {
  direction: "INBOUND",
  chassis_number: "CHS-1",
  customer_name: "Acme Freight",
  driver_name: "R. Driver",
};

/** Every other column a caller may set. Anything outside both lists is a typo. */
const JOB_CARD_OPTIONAL = [
  "container_number",
  "inspected_at",
  "size",
  "equipment_form",
  "location",
  "trucker_name",
  "status",
  "client_uuid",
] as const;

export async function seedJobCard(
  depotId: string,
  equipmentTypeId: string,
  values: Record<string, unknown> = {},
): Promise<string> {
  const allowed = new Set([...Object.keys(JOB_CARD_DEFAULTS), ...JOB_CARD_OPTIONAL]);
  for (const key of Object.keys(values)) {
    if (!allowed.has(key)) throw new Error(`seedJobCard does not know the column ${key}`);
  }

  const columns = ["job_number", "depot_id", "equipment_type_id"];
  const params: unknown[] = [await generateJobNumber(), depotId, equipmentTypeId];

  for (const [column, fallback] of Object.entries(JOB_CARD_DEFAULTS)) {
    columns.push(column);
    // `in` rather than `??`: an explicit null must clear the column, not fall
    // through to the default.
    params.push(column in values ? values[column] : fallback);
  }
  for (const column of JOB_CARD_OPTIONAL) {
    if (!(column in values)) continue;
    columns.push(column);
    params.push(values[column]);
  }

  const { rows } = await pool.query<{ id: string }>(
    `INSERT INTO job_cards (${columns.join(", ")})
     VALUES (${columns.map((_, i) => `$${i + 1}`).join(", ")})
     RETURNING id`,
    params,
  );
  return rows[0].id;
}

/**
 * Master data the inspection-item tests need.
 *
 * These live in migration 004 and `resetDb` deliberately does not truncate
 * them, so every name and code here is generated: a fixed literal collides on
 * the second test in a file against the UNIQUE constraints those tables carry.
 */

export async function seedComponent(): Promise<string> {
  const { rows } = await pool.query<{ id: string }>(
    `INSERT INTO components (component_code, component_description, slug_id)
     VALUES ('C-' || generate_slug_id(8), 'Fixture component',
             generate_unique_slug_id('components'))
     RETURNING id`,
  );
  return rows[0].id;
}

export async function seedMainView(equipmentTypeId: string): Promise<string> {
  const { rows } = await pool.query<{ id: string }>(
    `INSERT INTO main_views (equipment_type_id, name, slug_id)
     VALUES ($1, 'View-' || generate_slug_id(8), generate_unique_slug_id('main_views'))
     RETURNING id`,
    [equipmentTypeId],
  );
  return rows[0].id;
}

export async function seedSubview(
  mainViewId: string,
  componentId: string | null = null,
): Promise<string> {
  const { rows } = await pool.query<{ id: string }>(
    `INSERT INTO subviews (main_view_id, component_id, name, slug_id)
     VALUES ($1, $2, 'Sub-' || generate_slug_id(8), generate_unique_slug_id('subviews'))
     RETURNING id`,
    [mainViewId, componentId],
  );
  return rows[0].id;
}

export async function seedDamageCode(): Promise<string> {
  const { rows } = await pool.query<{ id: string }>(
    `INSERT INTO damage_codes (damage_code, damage_description)
     VALUES ('DMG-' || generate_slug_id(8), 'Fixture damage')
     RETURNING id`,
  );
  return rows[0].id;
}

export async function seedRepairCode(): Promise<string> {
  const { rows } = await pool.query<{ id: string }>(
    `INSERT INTO repair_codes (repair_code, repair_description)
     VALUES ('RPR-' || generate_slug_id(8), 'Fixture repair')
     RETURNING id`,
  );
  return rows[0].id;
}

/**
 * `name` is what drives widget kind resolution, so tests that care about
 * coercion pass a real legacy-style name ("TextBox", "Number"); tests that
 * only need a field to exist let it default to something unrecognized, which
 * exercises the UNKNOWN path for free.
 *
 * A named call upserts rather than inserting. `widget_types.name` is UNIQUE
 * and `resetDb` never truncates master data, so a literal name collides on its
 * second use -- across files and across runs. Sharing one row is also the
 * truthful shape: a widget type is global master data, not per-test fixture.
 */
export async function seedWidgetType(name?: string): Promise<string> {
  const { rows } = await pool.query<{ id: string }>(
    `INSERT INTO widget_types (name)
     VALUES (COALESCE($1, 'Widget-' || generate_slug_id(8)))
     ON CONFLICT (name) DO UPDATE SET name = EXCLUDED.name
     RETURNING id`,
    [name ?? null],
  );
  return rows[0].id;
}

export async function seedSubviewField(
  subviewId: string,
  widgetTypeId: string,
  fieldName?: string,
): Promise<string> {
  const name = fieldName ?? `field_${crypto.randomBytes(6).toString("hex")}`;
  const { rows } = await pool.query<{ id: string }>(
    `INSERT INTO subview_fields (subview_id, widget_type_id, label, field_name)
     VALUES ($1, $2, $3, $3)
     RETURNING id`,
    [subviewId, widgetTypeId, name],
  );
  return rows[0].id;
}

/**
 * `displayOrder` matters whenever a test asserts the order options come back
 * in: the column defaults to 0, so two options inserted without one tie and
 * fall through to the id tiebreak, which is a random UUID.
 */
export async function seedSubviewFieldOption(
  subviewFieldId: string,
  labelValue: string,
  displayOrder = 0,
): Promise<string> {
  const { rows } = await pool.query<{ id: string }>(
    `INSERT INTO subview_field_options (subview_field_id, label_value, display_order)
     VALUES ($1, $2, $3)
     RETURNING id`,
    [subviewFieldId, labelValue, displayOrder],
  );
  return rows[0].id;
}
