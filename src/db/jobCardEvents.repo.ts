/**
 * The job card audit trail.
 *
 * One writer for every status transition, so "who moved this card and when"
 * has a single shape rather than one per calling service. Migration 008
 * created the table; Phase 5 wrote the first row into it by hand, and this
 * module is where that inlined INSERT moved to.
 *
 * Rows are never updated or deleted. They go away only with the card, by
 * cascade.
 */

import { PoolClient } from "pg";
import { pool } from "./pool";
import { JobCardStatus } from "../types";

export interface JobCardEventRow {
  id: string;
  job_card_id: string;
  from_status: JobCardStatus | null;
  to_status: JobCardStatus;
  actor_user_id: string | null;
  note: string | null;
  created_at: Date;
}

export interface InsertJobCardEventInput {
  jobCardId: string;
  /** Null when there was no prior status — a card's own creation. */
  fromStatus: JobCardStatus | null;
  toStatus: JobCardStatus;
  actorUserId: string | null;
  note: string | null;
}

/** Anything that can run a query: the pool, or a client inside a transaction. */
type Executor = Pick<PoolClient, "query">;

/**
 * Records one transition.
 *
 * `executor` lets a caller already inside a transaction write the event in
 * that transaction, so the status change and the row recording it commit or
 * roll back together — an audit trail that can disagree with the data it
 * describes is worse than none. Callers with no transaction to join pass
 * nothing and get the pool.
 */
export async function insertJobCardEvent(
  input: InsertJobCardEventInput,
  executor: Executor = pool,
): Promise<JobCardEventRow> {
  const { rows } = await executor.query<JobCardEventRow>(
    `INSERT INTO job_card_events
       (job_card_id, from_status, to_status, actor_user_id, note)
     VALUES ($1, $2, $3, $4, $5)
     RETURNING *`,
    [input.jobCardId, input.fromStatus, input.toStatus, input.actorUserId, input.note],
  );
  return rows[0];
}

/**
 * A card's transitions, oldest first: an audit trail is read forward, unlike
 * the signature history, which answers "what holds now" and reads backward.
 *
 * `id` breaks the tie because two events written inside one transaction share
 * `now()` — the same reason the signature and item queries carry it.
 */
export async function listJobCardEvents(jobCardId: string): Promise<JobCardEventRow[]> {
  const { rows } = await pool.query<JobCardEventRow>(
    `SELECT * FROM job_card_events
      WHERE job_card_id = $1
      ORDER BY created_at, id`,
    [jobCardId],
  );
  return rows;
}
