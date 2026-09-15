import { AppError } from "../middleware/errors";
import {
  EquipmentTypeModelDetailsDto,
  EquipmentTypeModelSummaryDto,
} from "../types";
import * as equipmentRepo from "../db/equipment.repo";
import * as modelsRepo from "../db/equipmentModels.repo";
import { EquipmentTypeModelRow } from "../db/equipmentModels.repo";
import * as glbStorage from "../storage/glbStorage";
import { signGlbToken } from "../utils/assetToken";
import {
  ManifestValidationError,
  extractManifestFromGlb,
  validateManifest,
} from "../utils/manifest";
import { generateSlugId, isValidSlugId } from "../utils/slug-id";

const SLUG_ID_MAX_ATTEMPTS = 10;

export interface UploadModelInput {
  equipmentTypeIdOrSlug: string;
  glbBuffer: Buffer;
  originalFilename: string;
  uploadedBy: string | null;
}

/**
 * Resolve an equipment type by UUID or public slug_id, mirroring how
 * `/equipment-types/:id` accepts either identifier.
 */
async function resolveEquipmentType(idOrSlug: string): Promise<equipmentRepo.EquipmentTypeRow> {
  const equipmentType = isValidSlugId(idOrSlug)
    ? await equipmentRepo.getEquipmentTypeBySlugId(idOrSlug)
    : await equipmentRepo.getEquipmentType(idOrSlug);
  if (!equipmentType) throw new AppError(404, "Equipment type not found");
  return equipmentType;
}

async function generateUniqueSlugId(): Promise<string> {
  for (let attempt = 0; attempt < SLUG_ID_MAX_ATTEMPTS; attempt++) {
    const slugId = await generateSlugId();
    if (!(await modelsRepo.slugIdExists(slugId))) return slugId;
  }
  throw new Error(
    `Failed to generate a unique slug_id after ${SLUG_ID_MAX_ATTEMPTS} attempts`,
  );
}

export async function uploadModel(
  input: UploadModelInput,
): Promise<EquipmentTypeModelSummaryDto> {
  const equipmentType = await resolveEquipmentType(input.equipmentTypeIdOrSlug);

  // The manifest is derived from the GLB rather than uploaded alongside it, so
  // the two cannot describe different models. Extraction and validation share
  // one error channel: whether a problem is found while reading the GLB or
  // while checking the resulting hierarchy, the caller gets one 422 listing
  // every violation.
  let validated;
  try {
    const extracted = extractManifestFromGlb(input.glbBuffer, input.originalFilename);
    validated = validateManifest(extracted);
  } catch (err) {
    if (err instanceof ManifestValidationError) {
      throw new AppError(422, "Could not build a manifest from this GLB", err.violations);
    }
    throw err;
  }

  // Written before the transaction on purpose: if the insert then fails, the
  // file is inert — it is content-addressed and referenced by nothing, and a
  // retry reuses it rather than writing a duplicate. The reverse order could
  // leave a row pointing at a file that was never written.
  const stored = await glbStorage.put(equipmentType.id, input.glbBuffer);

  const row = await modelsRepo.insertModelVersion({
    equipmentTypeId: equipmentType.id,
    slugId: await generateUniqueSlugId(),
    manifest: validated.manifest,
    manifestVersion: validated.manifest.manifest_version,
    nodeCount: validated.nodeCount,
    storageKey: stored.storageKey,
    originalFilename: input.originalFilename,
    fileSizeBytes: stored.sizeBytes,
    checksumSha256: stored.checksumSha256,
    uploadedBy: input.uploadedBy,
  });

  return toSummaryDto(row);
}

export async function getModelDetailsDto(
  equipmentTypeIdOrSlug: string,
  versionNumber: number | undefined,
  requestingUserId: string,
): Promise<EquipmentTypeModelDetailsDto> {
  const equipmentType = await resolveEquipmentType(equipmentTypeIdOrSlug);

  const row =
    versionNumber === undefined
      ? await modelsRepo.getActiveModel(equipmentType.id)
      : await modelsRepo.getModelByVersion(equipmentType.id, versionNumber);

  if (!row) {
    throw new AppError(
      404,
      versionNumber === undefined
        ? "No 3D model has been uploaded for this equipment type"
        : `No 3D model version ${versionNumber} for this equipment type`,
    );
  }

  const signed = signGlbToken(row.id, requestingUserId);

  return {
    id: row.id,
    slug_id: row.slug_id,
    equipment_type_id: row.equipment_type_id,
    equipment_type_slug_id: equipmentType.slug_id,
    version_number: row.version_number,
    is_active: row.is_active,
    manifest_version: row.manifest_version,
    node_count: row.node_count,
    manifest: row.manifest,
    glb: {
      download_url: `/assets/glb/${signed.token}`,
      expires_at: signed.expiresAt,
      original_filename: row.original_filename,
      content_type: row.content_type,
      // file_size_bytes is a BIGINT, which node-postgres returns as a string
      // to avoid precision loss. A GLB is nowhere near 2^53 bytes, so it is
      // safe to hand clients a number.
      size_bytes: Number(row.file_size_bytes),
      checksum_sha256: row.checksum_sha256,
    },
    created_at: row.created_at.toISOString(),
    updated_at: row.updated_at.toISOString(),
  };
}

/**
 * Resolve a verified download token to the file it points at.
 *
 * @throws AppError 410 when the row survives but its file is gone from disk —
 * a distinct condition from an invalid token, and worth telling the caller
 * apart from a 404.
 */
export async function resolveGlbForDownload(
  modelId: string,
): Promise<{ row: EquipmentTypeModelRow; absolutePath: string }> {
  const row = await modelsRepo.getModelById(modelId);
  if (!row) throw new AppError(404, "Model not found");

  if (!(await glbStorage.exists(row.storage_key))) {
    throw new AppError(410, "The GLB file for this model is no longer available");
  }

  return { row, absolutePath: glbStorage.resolvePath(row.storage_key) };
}

function toSummaryDto(row: EquipmentTypeModelRow): EquipmentTypeModelSummaryDto {
  return {
    id: row.id,
    slug_id: row.slug_id,
    equipment_type_id: row.equipment_type_id,
    version_number: row.version_number,
    is_active: row.is_active,
    manifest_version: row.manifest_version,
    node_count: row.node_count,
    glb: {
      original_filename: row.original_filename,
      content_type: row.content_type,
      size_bytes: Number(row.file_size_bytes),
      checksum_sha256: row.checksum_sha256,
    },
    uploaded_by: row.uploaded_by,
    created_at: row.created_at.toISOString(),
  };
}
