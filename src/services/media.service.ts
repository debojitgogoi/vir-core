import * as repo from "../db/media.repo";
import { AppError, ERROR_CODES } from "../middleware/errors";
import { AttachMediaInput, RegisterMediaInput } from "../schemas/media.schemas";
import * as storage from "../storage/mediaStorage";
import { JobCardMediaKind, MediaAssetDto } from "../types";
import { signMediaToken } from "../utils/assetToken";

/**
 * Who is asking, and which depot the request resolved to. Media is scoped by
 * the *asset's* depot rather than the caller's current membership: memberships
 * move between depots over time and an uploaded photograph does not.
 */
export interface MediaActor {
  id: string;
  depotId: string;
}

export function toMediaAssetDto(
  row: repo.MediaAssetRow,
  kind?: JobCardMediaKind,
): MediaAssetDto {
  return {
    id: row.id,
    status: row.status,
    content_type: row.content_type,
    size_bytes: row.size_bytes,
    checksum_sha256: row.checksum_sha256,
    original_filename: row.original_filename,
    ...(kind ? { kind } : {}),
    uploaded_by: row.uploaded_by,
    created_at: row.created_at.toISOString(),
  };
}

const pgCode = (err: unknown): string | undefined => (err as { code?: string }).code;

async function loadAsset(mediaId: string): Promise<repo.MediaAssetRow> {
  const row = await repo.findMediaAssetById(mediaId);
  if (!row) throw new AppError(404, "Media asset not found");
  return row;
}

/**
 * A caller may only touch an asset registered at the depot their request
 * resolved to. Reported as 404 rather than 403 so a caller scoped elsewhere
 * cannot use the difference to discover that an asset exists.
 */
function assertSameDepot(row: repo.MediaAssetRow, actor: MediaActor): void {
  if (row.depot_id !== actor.depotId) {
    throw new AppError(404, "Media asset not found");
  }
}

export async function registerMedia(
  depotId: string,
  input: RegisterMediaInput,
  actorId: string,
): Promise<MediaAssetDto> {
  const row = await repo.insertMediaAsset({
    checksumSha256: input.checksum_sha256,
    contentType: input.content_type,
    sizeBytes: input.size_bytes,
    originalFilename: input.filename ?? null,
    depotId,
    uploadedBy: actorId,
  });
  return toMediaAssetDto(row);
}

export async function getMediaAsset(mediaId: string): Promise<MediaAssetDto> {
  return toMediaAssetDto(await loadAsset(mediaId));
}

/**
 * Receives the bytes for a registration.
 *
 * The checksum is verified *before* anything is written. Writing first and
 * checking after would leave unverified bytes in content-addressed storage at a
 * path the uploader chose, which is the whole point of verifying at all.
 */
export async function storeMediaContent(
  mediaId: string,
  buffer: Buffer,
  contentType: string,
  actor: MediaActor,
): Promise<MediaAssetDto> {
  const row = await loadAsset(mediaId);
  assertSameDepot(row, actor);

  if (contentType !== row.content_type) {
    throw new AppError(
      422,
      `These bytes were registered as ${row.content_type}, not ${contentType}`,
      undefined,
      ERROR_CODES.VALIDATION_ERROR,
    );
  }

  const actualChecksum = storage.sha256(buffer);
  if (actualChecksum !== row.checksum_sha256) {
    throw new AppError(
      422,
      "The uploaded bytes do not match the declared SHA-256",
      undefined,
      ERROR_CODES.CHECKSUM_MISMATCH,
    );
  }

  // Past this point the bytes are exactly what was registered, so an upload
  // that arrives twice — a retry after a dropped connection — is the same
  // write and the same row. `put` is idempotent for identical content.
  const stored = await storage.put(buffer, row.content_type);
  const ready = await repo.markMediaAssetReady(row.id, stored.storageKey, stored.sizeBytes);
  if (!ready) throw new AppError(404, "Media asset not found");

  return toMediaAssetDto(ready);
}

export async function signMediaUrl(
  mediaId: string,
  actor: MediaActor,
): Promise<{ url: string; expires_at: string }> {
  const row = await loadAsset(mediaId);
  // Without this the URL is mintable by any authenticated user for any media
  // id, which would make the depot scoping on every other route pointless: a
  // signed URL needs no token of its own to redeem.
  assertSameDepot(row, actor);

  if (row.status !== "READY") {
    throw new AppError(
      409,
      "This media has no content yet",
      undefined,
      ERROR_CODES.MEDIA_NOT_READY,
    );
  }

  const signed = signMediaToken(row.id, actor.id);
  return { url: `/assets/media/${signed.token}`, expires_at: signed.expiresAt };
}

export async function attachToJobCard(
  jobCardId: string,
  input: AttachMediaInput,
  actor: MediaActor,
): Promise<MediaAssetDto> {
  const row = await loadAsset(input.media_id);
  assertSameDepot(row, actor);

  if (row.status !== "READY") {
    throw new AppError(
      409,
      "This media has no content yet and cannot be attached",
      undefined,
      ERROR_CODES.MEDIA_NOT_READY,
    );
  }

  try {
    await repo.insertJobCardMedia({
      jobCardId,
      mediaAssetId: row.id,
      kind: input.kind,
      createdBy: actor.id,
    });
  } catch (err) {
    // The UNIQUE on (job_card_id, media_asset_id) fired: this asset is already
    // on this card. A retried attach is a retry, not a conflict.
    if (pgCode(err) !== "23505") throw err;
  }

  return toMediaAssetDto(row, input.kind);
}

export async function detachFromJobCard(jobCardId: string, mediaId: string): Promise<void> {
  const removed = await repo.deleteJobCardMedia(jobCardId, mediaId);
  if (!removed) {
    throw new AppError(404, "That media is not attached to this job card");
  }
  // The asset row and its bytes stay: they may be attached to another card,
  // and content-addressed storage is only ever swept by a reaper that has
  // checked every link first.
}

export async function listForJobCard(jobCardId: string): Promise<MediaAssetDto[]> {
  const rows = await repo.listJobCardMedia(jobCardId);
  return rows.map((row) => toMediaAssetDto(row, row.kind));
}

/**
 * The card read needs each attachment ready to display, so a URL is signed per
 * asset rather than making the client fetch one for each. No depot check here:
 * the caller has already been through requireDepotAccess for this card, and
 * these assets are attached to it.
 */
export async function listWithUrlsForJobCard(
  jobCardId: string,
  actorId: string,
): Promise<(MediaAssetDto & { url: string; expires_at: string })[]> {
  const rows = await repo.listJobCardMedia(jobCardId);
  return rows.map((row) => {
    const signed = signMediaToken(row.id, actorId);
    return {
      ...toMediaAssetDto(row, row.kind),
      url: `/assets/media/${signed.token}`,
      expires_at: signed.expiresAt,
    };
  });
}

/**
 * Everything the download route needs. Mirrors
 * equipmentModelsService.resolveGlbForDownload: 404 when the row is gone, 410
 * when the row is present but its bytes are not.
 */
export async function resolveMediaForDownload(
  mediaId: string,
): Promise<{ row: repo.MediaAssetRow; absolutePath: string }> {
  const row = await loadAsset(mediaId);

  if (row.status !== "READY" || !(await storage.exists(row.storage_key))) {
    throw new AppError(410, "The file for this media is no longer available");
  }

  return { row, absolutePath: storage.resolvePath(row.storage_key) };
}
