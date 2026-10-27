import * as repo from "../db/signatures.repo";
import * as jobCardsRepo from "../db/jobCards.repo";
import * as mediaRepo from "../db/media.repo";
import { env } from "../config/env";
import { AppError, ERROR_CODES } from "../middleware/errors";
import {
  RecordSignatureInput,
  SIGNED_AT_MAX_BACKDATE_MS,
  SIGNED_AT_MAX_SKEW_MS,
} from "../schemas/signature.schemas";
import { toJobCardDto } from "./jobCards.service";
import type { MediaActor } from "./media.service";
import { JobCardDto, MEDIA_CONTENT_TYPES, SignatureDto, SignatureVerification } from "../types";
import * as receipt from "../utils/signatureReceipt";
import { signMediaToken } from "../utils/assetToken";
import * as mediaStorage from "../storage/mediaStorage";

const pgCode = (err: unknown): string | undefined => (err as { code?: string }).code;

function toDtoBase(row: repo.SignatureRow): SignatureDto {
  return {
    id: row.id,
    job_card_id: row.job_card_id,
    signer_name: row.signer_name,
    signer_role: row.signer_role,
    signed_at: row.signed_at.toISOString(),
    payload_hash: row.payload_hash,
    key_version: row.key_version,
    payload_version: row.payload_version,
    device_id: row.device_id,
    created_by: row.created_by,
    created_at: row.created_at.toISOString(),
    // receipt_hmac and nonce are deliberately absent. Verification happens
    // here, so a client has no use for either, and publishing the nonce would
    // give away one of the six inputs the HMAC binds.
  };
}

async function imageUrls(
  mediaId: string | null,
  actorId: string | undefined,
): Promise<Pick<SignatureDto, "image_url" | "expires_at" | "download_url">> {
  if (!mediaId || !actorId) return {};
  const asset = await mediaRepo.findMediaAssetById(mediaId);
  if (!asset || asset.status !== "READY" || !asset.storage_key) return {};

  const signed = signMediaToken(asset.id, actorId);
  const download = await mediaStorage.resolveDownload(asset.storage_key, {
    ttlSeconds: env.mediaUrlTtlSeconds,
  });
  return {
    image_url: `/assets/media/${signed.token}`,
    expires_at: signed.expiresAt,
    ...(download.kind === "url" ? { download_url: download.url } : {}),
  };
}

async function toDto(row: repo.SignatureRow, actorId?: string): Promise<SignatureDto> {
  return { ...toDtoBase(row), ...(await imageUrls(row.media_id, actorId)) };
}

/**
 * The card as the receipt scheme sees it.
 *
 * `can_edit` is passed as false and is not part of any payload version — it is
 * computed per caller, so letting it near the canonical form would make a
 * receipt's validity depend on who asked.
 */
async function cardForSigning(jobCardId: string): Promise<JobCardDto> {
  const row = await jobCardsRepo.findJobCardById(jobCardId);
  if (!row) throw new AppError(404, "Job card not found");
  return toJobCardDto(row, false);
}

function resolveSignedAt(supplied: string | undefined): Date {
  if (!supplied) return new Date();

  const signedAt = new Date(supplied);
  const drift = Date.now() - signedAt.getTime();

  if (drift > SIGNED_AT_MAX_BACKDATE_MS) {
    throw new AppError(
      400,
      "signed_at is too far in the past to accept",
      [`signed_at: must be within ${SIGNED_AT_MAX_BACKDATE_MS / 86_400_000} days of now`],
      ERROR_CODES.VALIDATION_ERROR,
    );
  }
  if (drift < -SIGNED_AT_MAX_SKEW_MS) {
    throw new AppError(
      400,
      "signed_at is in the future",
      ["signed_at: must not be later than now"],
      ERROR_CODES.VALIDATION_ERROR,
    );
  }
  return signedAt;
}

export async function recordSignature(
  jobCardId: string,
  input: RecordSignatureInput,
  actorId: string,
): Promise<SignatureDto> {
  const card = await cardForSigning(jobCardId);
  const signedAt = resolveSignedAt(input.signed_at);

  const payloadVersion = receipt.CURRENT_PAYLOAD_VERSION;
  const nonce = receipt.newNonce();
  const hash = receipt.payloadHash(card, payloadVersion);
  const { hmac, keyVersion } = receipt.signReceipt({
    jobCardId,
    signerName: input.signer_name,
    signerRole: input.signer_role,
    signedAtIso: signedAt.toISOString(),
    nonce,
    payloadHash: hash,
  });

  const row = await repo.insertSignature({
    jobCardId,
    signerName: input.signer_name,
    signerRole: input.signer_role,
    signedAt,
    nonce,
    payloadHash: hash,
    receiptHmac: hmac,
    keyVersion,
    payloadVersion,
    deviceId: input.device_id,
    createdBy: actorId,
  });

  return toDtoBase(row);
}

export async function attachSignatureImage(
  jobCardId: string,
  mediaId: string,
  actor: MediaActor,
): Promise<SignatureDto> {
  const latest = await repo.findLatestSignature(jobCardId);
  if (!latest) throw new AppError(404, "No signature has been recorded for this job card");
  if (latest.media_id) {
    throw new AppError(409, "This receipt already has a signature image");
  }

  const asset = await mediaRepo.findMediaAssetById(mediaId);
  if (!asset || asset.depot_id !== actor.depotId) {
    throw new AppError(404, "Media asset not found");
  }
  if (asset.status !== "READY") {
    throw new AppError(
      409,
      "This media has no content yet and cannot be attached",
      undefined,
      ERROR_CODES.MEDIA_NOT_READY,
    );
  }
  if (!(MEDIA_CONTENT_TYPES as readonly string[]).includes(asset.content_type)) {
    throw new AppError(400, "Signature image must be an image file");
  }

  let row: repo.SignatureRow | null;
  try {
    row = await repo.setLatestSignatureMedia(jobCardId, mediaId);
  } catch (err) {
    if (pgCode(err) === "23505") {
      throw new AppError(409, "This image is already attached to a signature");
    }
    throw err;
  }
  if (!row) {
    throw new AppError(409, "This receipt already has a signature image");
  }

  return toDto(row, actor.id);
}

/**
 * Recomputes both halves of the receipt against the card's *current* content.
 *
 * The order of the two checks is what makes the answer useful. A payload
 * mismatch means the acknowledged content changed — ordinary, and the fix is
 * to re-sign. An HMAC mismatch while the payload still matches means the
 * stored row itself was edited, which is not ordinary at all and where
 * "re-sign the card" would be exactly the wrong advice.
 *
 * `actorId` is optional: submission only needs valid/reason. When present and
 * the receipt has ink, the response includes image URLs.
 */
export async function verifySignature(
  jobCardId: string,
  actorId?: string,
): Promise<SignatureVerification> {
  const card = await cardForSigning(jobCardId);

  const row = await repo.findLatestSignature(jobCardId);
  if (!row) return { valid: false, reason: "NO_SIGNATURE" };

  let expectedHash: string;
  let expectedHmac: string;
  try {
    expectedHash = receipt.payloadHash(card, row.payload_version);
    expectedHmac = receipt.computeHmac(
      {
        jobCardId: row.job_card_id,
        signerName: row.signer_name,
        signerRole: row.signer_role,
        signedAtIso: row.signed_at.toISOString(),
        nonce: row.nonce,
        payloadHash: row.payload_hash,
      },
      row.key_version,
    );
  } catch (err) {
    if (
      err instanceof receipt.UnknownKeyVersionError ||
      err instanceof receipt.UnknownPayloadVersionError
    ) {
      // Neither valid nor invalid: this build cannot judge the receipt at all.
      // Reporting it invalid would tell an operator the customer's
      // acknowledgment failed, when the truth is that a key was retired.
      return { valid: false, reason: "RECEIPT_UNVERIFIABLE" };
    }
    throw err;
  }

  if (row.payload_hash !== expectedHash) return { valid: false, reason: "CONTENT_MODIFIED" };
  if (!receipt.hmacEquals(row.receipt_hmac, expectedHmac)) {
    return { valid: false, reason: "RECEIPT_TAMPERED" };
  }

  return {
    valid: true,
    signed_at: row.signed_at.toISOString(),
    signer_name: row.signer_name,
    signer_role: row.signer_role,
    key_version: row.key_version,
    payload_version: row.payload_version,
    ...(await imageUrls(row.media_id, actorId)),
  };
}

export async function listSignatureHistory(
  jobCardId: string,
  actorId?: string,
): Promise<SignatureDto[]> {
  // Asserts the card exists first, so an unknown id is a 404 rather than an
  // empty list that reads as "this card has never been signed".
  await cardForSigning(jobCardId);
  const rows = await repo.listSignatures(jobCardId);
  return Promise.all(rows.map((row) => toDto(row, actorId)));
}
