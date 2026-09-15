import { pool } from "./pool";
import { JobCardMediaKind, MediaContentType, MediaStatus } from "../types";

/**
 * `size_bytes` is BIGINT, which node-postgres hands back as a string so that
 * values beyond 2^53 survive. Photographs never approach that, so it is
 * converted to a number here — at the boundary, once — rather than leaving
 * every consumer to remember. parseInt would truncate a large value silently;
 * Number is exact for every integer a file size can be.
 */
interface MediaAssetRaw {
  id: string;
  storage_key: string;
  checksum_sha256: string;
  content_type: MediaContentType;
  size_bytes: string;
  original_filename: string | null;
  status: MediaStatus;
  depot_id: string | null;
  uploaded_by: string | null;
  created_at: Date;
  updated_at: Date;
}

export interface MediaAssetRow extends Omit<MediaAssetRaw, "size_bytes"> {
  size_bytes: number;
}

/** A media asset as attached to a job card: the asset plus its link's kind. */
export interface AttachedMediaRow extends MediaAssetRow {
  kind: JobCardMediaKind;
  attached_at: Date;
}

export interface JobCardMediaRow {
  id: string;
  job_card_id: string;
  media_asset_id: string;
  kind: JobCardMediaKind;
  created_by: string | null;
  created_at: Date;
}

function toRow<T extends { size_bytes: string }>(
  raw: T,
): Omit<T, "size_bytes"> & { size_bytes: number } {
  return { ...raw, size_bytes: Number(raw.size_bytes) };
}

export interface InsertMediaAssetInput {
  checksumSha256: string;
  contentType: string;
  sizeBytes: number;
  originalFilename: string | null;
  depotId: string | null;
  uploadedBy: string | null;
}

/**
 * Registers an intended upload. The row is PENDING with no storage key: the
 * checksum is the client's declaration until bytes arrive to check it against.
 */
export async function insertMediaAsset(
  input: InsertMediaAssetInput,
): Promise<MediaAssetRow> {
  const { rows } = await pool.query<MediaAssetRaw>(
    `INSERT INTO media_assets
       (checksum_sha256, content_type, size_bytes, original_filename, depot_id, uploaded_by)
     VALUES ($1, $2, $3, $4, $5, $6)
     RETURNING *`,
    [
      input.checksumSha256,
      input.contentType,
      input.sizeBytes,
      input.originalFilename,
      input.depotId,
      input.uploadedBy,
    ],
  );
  return toRow(rows[0]);
}

export async function findMediaAssetById(id: string): Promise<MediaAssetRow | null> {
  const { rows } = await pool.query<MediaAssetRaw>(
    "SELECT * FROM media_assets WHERE id = $1",
    [id],
  );
  return rows[0] ? toRow(rows[0]) : null;
}

/**
 * Promotes a registration to READY once its bytes are on disk. `sizeBytes` is
 * what actually arrived, replacing the client's declaration.
 */
export async function markMediaAssetReady(
  id: string,
  storageKey: string,
  sizeBytes: number,
): Promise<MediaAssetRow | null> {
  const { rows } = await pool.query<MediaAssetRaw>(
    `UPDATE media_assets
        SET status = 'READY', storage_key = $2, size_bytes = $3
      WHERE id = $1
      RETURNING *`,
    [id, storageKey, sizeBytes],
  );
  return rows[0] ? toRow(rows[0]) : null;
}

export interface InsertJobCardMediaInput {
  jobCardId: string;
  mediaAssetId: string;
  kind: JobCardMediaKind;
  createdBy: string | null;
}

export async function insertJobCardMedia(
  input: InsertJobCardMediaInput,
): Promise<JobCardMediaRow> {
  const { rows } = await pool.query<JobCardMediaRow>(
    `INSERT INTO job_card_media (job_card_id, media_asset_id, kind, created_by)
     VALUES ($1, $2, $3, $4)
     RETURNING *`,
    [input.jobCardId, input.mediaAssetId, input.kind, input.createdBy],
  );
  return rows[0];
}

export async function findJobCardMediaLink(
  jobCardId: string,
  mediaAssetId: string,
): Promise<JobCardMediaRow | null> {
  const { rows } = await pool.query<JobCardMediaRow>(
    "SELECT * FROM job_card_media WHERE job_card_id = $1 AND media_asset_id = $2",
    [jobCardId, mediaAssetId],
  );
  return rows[0] ?? null;
}

export async function listJobCardMedia(jobCardId: string): Promise<AttachedMediaRow[]> {
  const { rows } = await pool.query<MediaAssetRaw & { kind: JobCardMediaKind; attached_at: Date }>(
    `SELECT a.*, l.kind, l.created_at AS attached_at
       FROM job_card_media l
       JOIN media_assets a ON a.id = l.media_asset_id
      WHERE l.job_card_id = $1
      ORDER BY l.created_at DESC, l.id DESC`,
    [jobCardId],
  );
  return rows.map(toRow);
}

/** @returns true when a link was removed, false when there was none. */
export async function deleteJobCardMedia(
  jobCardId: string,
  mediaAssetId: string,
): Promise<boolean> {
  const result = await pool.query(
    "DELETE FROM job_card_media WHERE job_card_id = $1 AND media_asset_id = $2",
    [jobCardId, mediaAssetId],
  );
  return (result.rowCount ?? 0) > 0;
}

// --- Reaper queries -------------------------------------------------------

export interface OrphanedMediaRow {
  id: string;
  storage_key: string;
  status: MediaStatus;
  size_bytes: number;
  created_at: Date;
}

/**
 * Media nothing points at any more.
 *
 * **Both link tables must appear in this query.** Omitting either one would
 * report live photographs as orphans and delete them — job_card_media covers
 * intake attachments, inspection_item_media covers line-item photographs, and
 * an asset referenced by either is in use.
 *
 * @param pendingBefore PENDING rows older than this are treated as uploads that
 * never arrived. Anything newer may still be in flight.
 */
export async function findOrphanedMedia(pendingBefore: Date): Promise<OrphanedMediaRow[]> {
  const { rows } = await pool.query<Omit<OrphanedMediaRow, "size_bytes"> & { size_bytes: string }>(
    `SELECT a.id, a.storage_key, a.status, a.size_bytes, a.created_at
       FROM media_assets a
      WHERE (a.status = 'PENDING' AND a.created_at < $1)
         OR (a.status = 'READY'
             AND NOT EXISTS (
               SELECT 1 FROM job_card_media l WHERE l.media_asset_id = a.id)
             AND NOT EXISTS (
               SELECT 1 FROM inspection_item_media l WHERE l.media_asset_id = a.id))
      ORDER BY a.created_at, a.id`,
    [pendingBefore],
  );
  return rows.map((raw) => ({ ...raw, size_bytes: Number(raw.size_bytes) }));
}

/**
 * Deletes one asset row.
 *
 * ON DELETE RESTRICT on both link tables means this refuses rather than
 * cascading if the asset gained a reference since it was found. The caller
 * treats a refusal as "leave it alone", which is the correct outcome.
 *
 * @returns true when a row was removed.
 */
export async function deleteMediaAsset(id: string): Promise<boolean> {
  const result = await pool.query("DELETE FROM media_assets WHERE id = $1", [id]);
  return (result.rowCount ?? 0) > 0;
}

/**
 * Whether any surviving asset row still points at this storage key.
 *
 * The store is content-addressed, so two uploads of identical bytes share one
 * file. Unlinking that file because one of its rows was reaped would destroy a
 * photograph another card is still showing.
 */
export async function storageKeyStillReferenced(storageKey: string): Promise<boolean> {
  const { rows } = await pool.query(
    "SELECT 1 FROM media_assets WHERE storage_key = $1 LIMIT 1",
    [storageKey],
  );
  return rows.length > 0;
}
