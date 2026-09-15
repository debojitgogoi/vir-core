import * as repo from "../db/signatures.repo";
import * as jobCardsRepo from "../db/jobCards.repo";
import { AppError, ERROR_CODES } from "../middleware/errors";
import {
  RecordSignatureInput,
  SIGNED_AT_MAX_BACKDATE_MS,
  SIGNED_AT_MAX_SKEW_MS,
} from "../schemas/signature.schemas";
import { toJobCardDto } from "./jobCards.service";
import { JobCardDto, SignatureDto, SignatureVerification } from "../types";
import * as receipt from "../utils/signatureReceipt";

function toDto(row: repo.SignatureRow): SignatureDto {
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

  return toDto(row);
}

/**
 * Recomputes both halves of the receipt against the card's *current* content.
 *
 * The order of the two checks is what makes the answer useful. A payload
 * mismatch means the acknowledged content changed — ordinary, and the fix is
 * to re-sign. An HMAC mismatch while the payload still matches means the
 * stored row itself was edited, which is not ordinary at all and where
 * "re-sign the card" would be exactly the wrong advice.
 */
export async function verifySignature(jobCardId: string): Promise<SignatureVerification> {
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
  };
}

export async function listSignatureHistory(jobCardId: string): Promise<SignatureDto[]> {
  // Asserts the card exists first, so an unknown id is a 404 rather than an
  // empty list that reads as "this card has never been signed".
  await cardForSigning(jobCardId);
  return (await repo.listSignatures(jobCardId)).map(toDto);
}
