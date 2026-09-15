import { pool } from "./pool";
import { Role } from "../types";

export interface DepotRow {
  id: string;
  slug_id: string;
  code: string;
  name: string;
  timezone: string;
  address: string | null;
  is_disabled: boolean;
  created_at: Date;
  updated_at: Date;
}

export interface DepotMemberRow {
  id: string;
  depot_id: string;
  user_id: string;
  is_active: boolean;
  assigned_at: Date;
  unassigned_at: Date | null;
  created_at: Date;
  updated_at: Date;
}

export interface DepotMemberWithUser {
  user_id: string;
  name: string | null;
  email: string;
  role: Role;
  assigned_at: Date;
}

export async function findDepotById(id: string): Promise<DepotRow | null> {
  const { rows } = await pool.query<DepotRow>("SELECT * FROM depots WHERE id = $1", [id]);
  return rows[0] ?? null;
}

export async function findDepotByCode(code: string): Promise<DepotRow | null> {
  const { rows } = await pool.query<DepotRow>("SELECT * FROM depots WHERE code = $1", [code]);
  return rows[0] ?? null;
}

export async function listDepots(opts: {
  limit: number;
  offset: number;
  /** Disabled depots are hidden by default; an admin needs them to re-enable one. */
  includeDisabled?: boolean;
}): Promise<{ rows: DepotRow[]; total: number }> {
  const clause = opts.includeDisabled ? "" : "WHERE is_disabled = false";

  // count(*) OVER () rides along with the page, so listing costs one round
  // trip instead of two and can never report a total from a different instant.
  const { rows: rawRows } = await pool.query<DepotRow & { total_count: string }>(
    `SELECT *, count(*) OVER () AS total_count
       FROM depots
       ${clause}
      ORDER BY code
      LIMIT $1 OFFSET $2`,
    [opts.limit, opts.offset],
  );

  // Extract total_count and strip it from rows to match the declared return type.
  // total_count is an internal pagination artifact that must not leak to callers.
  const total = rawRows.length > 0 ? Number(rawRows[0].total_count) : await countDepots(clause);
  const rows = rawRows.map(({ total_count: _totalCount, ...row }) => row);

  return { rows, total };
}

/** Only reached when the requested page falls past the end of the results. */
async function countDepots(clause: string): Promise<number> {
  const { rows } = await pool.query<{ count: string }>(
    `SELECT count(*) FROM depots ${clause}`,
  );
  return Number(rows[0].count);
}

export interface InsertDepotInput {
  slugId: string;
  code: string;
  name: string;
  timezone: string;
  address: string | null;
}

export async function insertDepot(input: InsertDepotInput): Promise<DepotRow> {
  const { rows } = await pool.query<DepotRow>(
    `INSERT INTO depots (slug_id, code, name, timezone, address)
     VALUES ($1, $2, $3, $4, $5)
     RETURNING *`,
    [input.slugId, input.code, input.name, input.timezone, input.address],
  );
  return rows[0];
}

export interface UpdateDepotPatch {
  name?: string;
  timezone?: string;
  address?: string;
  isDisabled?: boolean;
}

/**
 * COALESCE leaves any omitted field untouched. The consequence is that a field
 * cannot be cleared back to NULL through this path; nothing needs that today,
 * and a dedicated clear endpoint is clearer than an overloaded patch.
 */
export async function updateDepot(
  id: string,
  patch: UpdateDepotPatch,
): Promise<DepotRow | null> {
  const { rows } = await pool.query<DepotRow>(
    `UPDATE depots
        SET name        = COALESCE($2, name),
            timezone    = COALESCE($3, timezone),
            address     = COALESCE($4, address),
            is_disabled = COALESCE($5, is_disabled)
      WHERE id = $1
      RETURNING *`,
    [id, patch.name ?? null, patch.timezone ?? null, patch.address ?? null, patch.isDisabled ?? null],
  );
  return rows[0] ?? null;
}

export async function findActiveDepotForUser(userId: string): Promise<DepotRow | null> {
  const { rows } = await pool.query<DepotRow>(
    `SELECT d.*
       FROM depot_members m
       JOIN depots d ON d.id = m.depot_id
      WHERE m.user_id = $1 AND m.is_active`,
    [userId],
  );
  return rows[0] ?? null;
}

/**
 * Reassignment is one transaction: the previous active membership is closed
 * before the new one is inserted, because ux_depot_members_active_user would
 * otherwise reject the insert.
 */
export async function assignUserToDepot(
  depotId: string,
  userId: string,
): Promise<DepotMemberRow> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(
      `UPDATE depot_members
          SET is_active = false, unassigned_at = now()
        WHERE user_id = $1 AND is_active`,
      [userId],
    );
    const { rows } = await client.query<DepotMemberRow>(
      `INSERT INTO depot_members (depot_id, user_id) VALUES ($1, $2) RETURNING *`,
      [depotId, userId],
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

export async function deactivateMembership(
  depotId: string,
  userId: string,
): Promise<boolean> {
  const { rowCount } = await pool.query(
    `UPDATE depot_members
        SET is_active = false, unassigned_at = now()
      WHERE depot_id = $1 AND user_id = $2 AND is_active`,
    [depotId, userId],
  );
  return (rowCount ?? 0) > 0;
}

export async function listActiveMembers(depotId: string): Promise<DepotMemberWithUser[]> {
  const { rows } = await pool.query<DepotMemberWithUser>(
    `SELECT u.id AS user_id, u.name, u.email, u.role, m.assigned_at
       FROM depot_members m
       JOIN users u ON u.id = m.user_id
      WHERE m.depot_id = $1 AND m.is_active
      ORDER BY u.name NULLS LAST, u.email`,
    [depotId],
  );
  return rows;
}
