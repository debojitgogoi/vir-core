import { pool } from "./pool";
import { insertJobCardEvent } from "./jobCardEvents.repo";
import { JobCardDirection, JobCardStatus } from "../types";
import { PATCHABLE_COLUMNS } from "../schemas/jobCard.schemas";

/**
 * The narrow projection the access middleware needs. Phase 2 adds the full
 * job-card queries to this file; deliberately kept separate so a middleware
 * running on every mutating request never loads forty intake columns.
 */
export interface JobCardAccessRow {
  id: string;
  depot_id: string;
  status: JobCardStatus;
  locked_at: Date | null;
}

export async function findJobCardAccessRow(
  id: string,
): Promise<JobCardAccessRow | null> {
  const { rows } = await pool.query<JobCardAccessRow>(
    "SELECT id, depot_id, status, locked_at FROM job_cards WHERE id = $1",
    [id],
  );
  return rows[0] ?? null;
}

export interface JobCardRow {
  id: string;
  job_number: string;
  depot_id: string;
  status: JobCardStatus;
  client_uuid: string | null;

  direction: JobCardDirection;
  equipment_type_id: string;
  trucker_name: string | null;
  location: string | null;
  inspected_at: Date | null;
  equipment_prefix_id: string | null;
  prefix_text: string | null;
  container_number: string | null;
  chassis_number: string | null;
  genset_status: string | null;
  size: number | null;
  equipment_form: string | null;
  serial_number: string | null;
  license_plate: string | null;
  license_state: string | null;
  // These three are DATE, not TIMESTAMPTZ, and arrive as 'YYYY-MM-DD' strings
  // because pool.ts overrides node-postgres's default parser for that type —
  // see the comment there for why turning them into Date objects loses a day.
  license_expiry_date: string | null;
  registration_status: string | null;
  pool_point: string | null;
  customer_name: string | null;
  redelivery_release_no: string | null;
  customer_account_no: string | null;
  on_hire_date: string | null;
  scac_code: string | null;
  fhwa_sticker_date: string | null;
  driver_name: string | null;
  manufacture_year: number | null;

  created_by: string | null;
  updated_by: string | null;
  submitted_by: string | null;
  submitted_at: Date | null;
  locked_at: Date | null;
  created_at: Date;
  updated_at: Date;
}

export interface InsertJobCardInput {
  jobNumber: string;
  depotId: string;
  clientUuid: string | null;
  createdBy: string | null;
  /** Already validated by the zod schema; keys are column names. */
  values: Record<string, unknown>;
}

/**
 * Columns the server owns outright. `updateJobCard` intersects its patch with
 * PATCHABLE_COLUMNS, which already excludes these; the list is a second line of
 * defence for a future caller that passes a hand-built column set.
 */
const SERVER_OWNED = ["id", "job_number", "depot_id", "status", "client_uuid", "locked_at"];

export async function insertJobCard(input: InsertJobCardInput): Promise<JobCardRow> {
  const columns = ["job_number", "depot_id", "client_uuid", "created_by", "updated_by"];
  const values: unknown[] = [
    input.jobNumber,
    input.depotId,
    input.clientUuid,
    input.createdBy,
    input.createdBy,
  ];

  for (const column of PATCHABLE_COLUMNS) {
    if (!Object.prototype.hasOwnProperty.call(input.values, column)) continue;
    columns.push(column);
    values.push(input.values[column]);
  }

  const placeholders = columns.map((_, i) => `$${i + 1}`).join(", ");
  const { rows } = await pool.query<JobCardRow>(
    `INSERT INTO job_cards (${columns.join(", ")})
     VALUES (${placeholders})
     RETURNING *`,
    values,
  );
  return rows[0];
}

export async function findJobCardById(id: string): Promise<JobCardRow | null> {
  const { rows } = await pool.query<JobCardRow>("SELECT * FROM job_cards WHERE id = $1", [id]);
  return rows[0] ?? null;
}

export async function findJobCardByClientUuid(
  depotId: string,
  clientUuid: string,
): Promise<JobCardRow | null> {
  const { rows } = await pool.query<JobCardRow>(
    "SELECT * FROM job_cards WHERE depot_id = $1 AND client_uuid = $2",
    [depotId, clientUuid],
  );
  return rows[0] ?? null;
}

export interface ListJobCardsFilter {
  depotId?: string;
  status?: JobCardStatus;
  direction?: JobCardDirection;
  q?: string;
  from?: string;
  to?: string;
  inspectedFrom?: string;
  inspectedTo?: string;
  limit: number;
  offset: number;
}

/**
 * `q` is embedded in a LIKE pattern, so its own % and _ must be neutralised —
 * otherwise a search for "%" returns the entire depot.
 */
function escapeLike(term: string): string {
  return term.replace(/[\\%_]/g, (ch) => `\\${ch}`);
}

function buildWhere(filter: ListJobCardsFilter): { clause: string; values: unknown[] } {
  const conditions: string[] = [];
  const values: unknown[] = [];

  const bind = (value: unknown): string => {
    values.push(value);
    return `$${values.length}`;
  };

  if (filter.depotId) conditions.push(`depot_id = ${bind(filter.depotId)}`);
  if (filter.status) conditions.push(`status = ${bind(filter.status)}`);
  if (filter.direction) conditions.push(`direction = ${bind(filter.direction)}`);
  if (filter.from) conditions.push(`created_at >= ${bind(filter.from)}`);
  if (filter.to) conditions.push(`created_at <= ${bind(filter.to)}`);
  // inspected_at is nullable, so these exclude a card that has never been
  // inspected. That is the point: asking "what did we inspect last Tuesday"
  // should not return cards nobody has inspected at all.
  if (filter.inspectedFrom) conditions.push(`inspected_at >= ${bind(filter.inspectedFrom)}`);
  if (filter.inspectedTo) conditions.push(`inspected_at <= ${bind(filter.inspectedTo)}`);
  if (filter.q) {
    const pattern = bind(`%${escapeLike(filter.q)}%`);
    conditions.push(
      `(job_number ILIKE ${pattern} ESCAPE '\\'
        OR container_number ILIKE ${pattern} ESCAPE '\\'
        OR chassis_number ILIKE ${pattern} ESCAPE '\\'
        OR customer_name ILIKE ${pattern} ESCAPE '\\')`,
    );
  }

  return {
    clause: conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "",
    values,
  };
}

export async function listJobCards(
  filter: ListJobCardsFilter,
): Promise<{ rows: JobCardRow[]; total: number }> {
  const { clause, values } = buildWhere(filter);

  // count(*) OVER () gives the unpaged total in the same scan, so the page and
  // its total can never disagree the way two separate queries can.
  const { rows: rawRows } = await pool.query<JobCardRow & { total_count: string }>(
    `SELECT *, count(*) OVER () AS total_count
       FROM job_cards
       ${clause}
      ORDER BY created_at DESC, id DESC
      LIMIT $${values.length + 1} OFFSET $${values.length + 2}`,
    [...values, filter.limit, filter.offset],
  );

  if (rawRows.length === 0) {
    // The window function returned no row to read the total from — the page is
    // past the end of the result set. The client still needs an accurate total
    // to render its pager, so count separately in exactly this case.
    return { rows: [], total: await countJobCards(clause, values) };
  }

  const total = Number(rawRows[0].total_count);
  const rows = rawRows.map(({ total_count: _totalCount, ...row }) => row);
  return { rows, total };
}

async function countJobCards(clause: string, values: unknown[]): Promise<number> {
  const { rows } = await pool.query<{ count: string }>(
    `SELECT count(*) AS count FROM job_cards ${clause}`,
    values,
  );
  return Number(rows[0].count);
}

/**
 * JSON Merge Patch semantics: the SET clause is built from the keys the patch
 * actually carries, so an absent key leaves the column alone and an explicit
 * null clears it. COALESCE cannot express the second case, which is why the
 * depot repository's pattern is not reused here.
 *
 * Keys outside PATCHABLE_COLUMNS are dropped rather than rejected — the zod
 * schema has already returned 400 for them, and dropping keeps this function
 * safe to call from a future sync path that has not been through that schema.
 */
export async function updateJobCard(
  id: string,
  patch: Record<string, unknown>,
  updatedBy: string | null,
): Promise<JobCardRow | null> {
  const sets: string[] = [];
  const values: unknown[] = [];

  for (const column of PATCHABLE_COLUMNS) {
    if (SERVER_OWNED.includes(column)) continue;
    if (!Object.prototype.hasOwnProperty.call(patch, column)) continue;
    values.push(patch[column]);
    sets.push(`${column} = $${values.length}`);
  }

  // An empty patch must still 404 on an unknown id, so it reads the row rather
  // than returning early with something fabricated.
  if (sets.length === 0) return findJobCardById(id);

  values.push(updatedBy);
  sets.push(`updated_by = $${values.length}`);

  // updated_at is left alone: migration 008's BEFORE UPDATE trigger owns it.
  values.push(id);
  // `AND locked_at IS NULL` closes the race requireUnlockedJobCard's earlier,
  // non-atomic read cannot: a submit that locks the row between that read and
  // this write must still win. A locked card and a missing one both return no
  // row here; the service tells them apart with a follow-up read.
  const { rows } = await pool.query<JobCardRow>(
    `UPDATE job_cards SET ${sets.join(", ")}
      WHERE id = $${values.length} AND locked_at IS NULL
      RETURNING *`,
    values,
  );
  return rows[0] ?? null;
}

/**
 * Submits a card and writes the audit row in the same transaction.
 *
 * The row is locked with SELECT ... FOR UPDATE before the status is read. That
 * does two things at once: it makes the previous status unambiguous — a
 * sub-select inside the UPDATE's RETURNING would depend on snapshot rules that
 * are easy to reason about wrongly — and it serialises two concurrent submits,
 * so the second one waits, sees SUBMITTED, and writes nothing. One transition,
 * one event, however many tablets tapped the button.
 *
 * @returns the submitted row, or null when the card does not exist or was
 * already submitted. Those are different answers, and the service re-reads to
 * tell them apart rather than this function guessing which the caller wants.
 */
export async function submitJobCard(
  id: string,
  actorId: string,
): Promise<JobCardRow | null> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    const { rows: locked } = await client.query<{ status: JobCardStatus }>(
      "SELECT status FROM job_cards WHERE id = $1 FOR UPDATE",
      [id],
    );
    if (locked.length === 0 || locked[0].status === "SUBMITTED") {
      await client.query("ROLLBACK");
      return null;
    }

    const { rows } = await client.query<JobCardRow>(
      `UPDATE job_cards
          SET status = 'SUBMITTED',
              submitted_at = now(),
              locked_at = now(),
              submitted_by = $2,
              updated_by = $2
        WHERE id = $1
        RETURNING *`,
      [id, actorId],
    );

    await insertJobCardEvent(
      {
        jobCardId: id,
        fromStatus: locked[0].status,
        toStatus: "SUBMITTED",
        actorUserId: actorId,
        note: "Submitted for estimation",
      },
      client,
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
