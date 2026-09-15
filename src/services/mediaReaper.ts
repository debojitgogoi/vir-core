/**
 * Sweeping media nothing points at any more.
 *
 * Three populations accumulate and nothing else removes any of them:
 *
 *   1. PENDING rows whose upload never arrived — a gatekeeper who registered a
 *      photograph and then lost signal.
 *   2. READY assets no link row references — everything detached from a card.
 *   3. READY assets stranded when an inspection item was deleted, since
 *      `inspection_item_media` cascades away with the item while the asset row
 *      stays behind.
 *
 * Two rules make this safe to run, and both are structural rather than
 * remembered:
 *
 * **Dry run by default.** `commit` must be passed explicitly. The command that
 * wraps this reports and exits unless told otherwise, so nothing deletes a
 * customer's evidence photograph because a script ran on a schedule nobody
 * reviewed.
 *
 * **The row goes before the file.** A crash between the two leaves an
 * unreferenced file, which the next sweep collects. The other order leaves a
 * READY row promising bytes that no longer exist, which is a 500 on a
 * customer's card and is not self-healing.
 */

import * as repo from "../db/media.repo";
import * as storage from "../storage/mediaStorage";

const pgCode = (err: unknown): string | undefined => (err as { code?: string }).code;

export interface OrphanRow {
  id: string;
  storage_key: string;
  status: "PENDING" | "READY";
  size_bytes: number;
  created_at: Date;
}

export interface ReapReport {
  /** What the sweep found, whether or not it removed anything. */
  orphans: OrphanRow[];
  /** True when this run was allowed to delete. */
  committed: boolean;
  rowsDeleted: number;
  filesDeleted: number;
  /** Bytes reclaimed, or that would be reclaimed on a dry run. */
  bytes: number;
  /**
   * Assets whose row went but whose file stayed, because another asset row
   * still points at the same content-addressed key. Not an error — the whole
   * point of content addressing is that identical bytes are stored once.
   */
  filesKeptShared: number;
}

/** A day is long enough that no honest upload is still in flight. */
export const DEFAULT_PENDING_AGE_MS = 24 * 60 * 60 * 1000;

export async function reapMedia(
  options: { commit?: boolean; pendingOlderThanMs?: number } = {},
): Promise<ReapReport> {
  const commit = options.commit ?? false;
  const pendingOlderThanMs = options.pendingOlderThanMs ?? DEFAULT_PENDING_AGE_MS;

  const orphans = await repo.findOrphanedMedia(new Date(Date.now() - pendingOlderThanMs));

  const report: ReapReport = {
    orphans,
    committed: commit,
    rowsDeleted: 0,
    filesDeleted: 0,
    bytes: orphans.reduce((sum, row) => sum + row.size_bytes, 0),
    filesKeptShared: 0,
  };

  if (!commit) return report;

  for (const orphan of orphans) {
    // ON DELETE RESTRICT on both link tables means a row that gained a
    // reference between the query and this delete refuses to go. That is the
    // safety net working, not an error to report — but it throws rather than
    // returning zero rows affected, so it has to be caught here rather than
    // read off the result the way a normal "already gone" miss is. Without
    // this, one row attached mid-sweep would abort the whole batch and leave
    // every orphan after it unprocessed until the next scheduled run.
    let deleted: boolean;
    try {
      deleted = await repo.deleteMediaAsset(orphan.id);
    } catch (err) {
      if (pgCode(err) === "23503") continue;
      throw err;
    }
    if (!deleted) continue;
    report.rowsDeleted += 1;

    // A PENDING row never had bytes written, so it has no key to unlink.
    if (orphan.storage_key === "") continue;

    // Checked after the row is gone: two assets can share one storage key,
    // because the store is content-addressed and identical uploads write once.
    // Unlinking without this would delete a live photograph belonging to
    // another card.
    if (await repo.storageKeyStillReferenced(orphan.storage_key)) {
      report.filesKeptShared += 1;
      continue;
    }

    if (await storage.remove(orphan.storage_key)) report.filesDeleted += 1;
  }

  return report;
}
