/**
 * Submission: the point where a job card stops being a working document and
 * becomes a record.
 *
 * Everything that must be true before a card can be submitted lives here, in
 * one list, rather than as NOT NULL constraints scattered across migration
 * 008. That is deliberate and stated in the spec: a gatekeeper must be able to
 * save a partial card mid-conversation with a driver, so completeness is a
 * submission-time rule, not a storage-time one.
 */

import * as repo from "../db/jobCards.repo";
import * as itemsRepo from "../db/inspectionItems.repo";
import { listJobCardEvents } from "../db/jobCardEvents.repo";
import { AppError, ERROR_CODES } from "../middleware/errors";
import { toJobCardDto } from "./jobCards.service";
import { verifySignature } from "./signatures.service";
import { JobCardDto, JobCardEventDto, SignatureInvalidReason } from "../types";

/**
 * Intake fields a card cannot be submitted without.
 *
 * `direction` and `equipment_type_id` are already NOT NULL in the schema and
 * cannot actually be missing; they stay in the list because the spec names
 * them, and a list that matches the spec is easier to audit than one that
 * silently drops the two the database happens to cover.
 */
export const REQUIRED_INTAKE_FIELDS = [
  "direction",
  "equipment_type_id",
  "inspected_at",
  "size",
  "equipment_form",
  "customer_name",
  "driver_name",
] as const;

/**
 * Why a receipt failed, and what to do about it.
 *
 * These are four different instructions, not four spellings of one. Collapsing
 * RECEIPT_TAMPERED into CONTENT_MODIFIED would tell an operator to re-sign
 * over what is actually an incident, which is the whole reason the reason codes
 * exist.
 */
const SIGNATURE_VIOLATION: Record<SignatureInvalidReason, string> = {
  NO_SIGNATURE: "signature: the customer has not signed this card",
  CONTENT_MODIFIED:
    "signature: an acknowledged field changed after signing, so the card must be re-signed",
  RECEIPT_TAMPERED:
    "signature: the stored receipt does not match its own contents. Do NOT re-sign — " +
    "this is an incident and needs investigating",
  RECEIPT_UNVERIFIABLE:
    "signature: the receipt names a signing key or payload version this server no longer " +
    "holds, so it cannot be judged either way",
};

/**
 * Everything wrong with this card, as violation strings.
 *
 * Returns rather than throws: the submit path decides the status code, and a
 * future "can I submit yet?" read can call this without catching an error to
 * find out. Every rule is checked even after one has already failed — a
 * gatekeeper fixing one field per round trip is the failure mode this avoids.
 */
export async function validateForSubmission(jobCardId: string): Promise<string[]> {
  const card = await repo.findJobCardById(jobCardId);
  if (!card) throw new AppError(404, "Job card not found");

  const [items, signature] = await Promise.all([
    itemsRepo.listInspectionItems(jobCardId),
    verifySignature(jobCardId),
  ]);

  const violations: string[] = [];

  for (const field of REQUIRED_INTAKE_FIELDS) {
    if (card[field] === null || card[field] === undefined) {
      violations.push(`${field}: required before submission`);
    }
  }

  // One rule spanning two columns, so one violation: telling a gatekeeper that
  // both fields are missing would suggest both are needed.
  if (!card.container_number && !card.chassis_number) {
    violations.push("container_number: one of container_number or chassis_number is required");
  }

  if (!signature.valid) {
    violations.push(SIGNATURE_VIOLATION[signature.reason]);
  }

  // An inspection item is not a damage report: an item carrying no damage codes
  // records "looked at this, it is fine". So zero items does not mean a clean
  // chassis, it means nobody inspected anything.
  if (items.length === 0) {
    violations.push("items: the card has no inspection items, so nothing was inspected");
  }

  return violations;
}

export async function submitJobCard(jobCardId: string, actorId: string): Promise<JobCardDto> {
  const existing = await repo.findJobCardById(jobCardId);
  if (!existing) throw new AppError(404, "Job card not found");

  // Idempotent by the spec: a retried submit — a double tap on a tablet, a
  // client retrying a timed-out request — is a retry, not a conflict.
  if (existing.status === "SUBMITTED") return toJobCardDto(existing, false);

  const violations = await validateForSubmission(jobCardId);
  if (violations.length > 0) {
    throw new AppError(
      422,
      "This card is not ready to submit",
      violations,
      ERROR_CODES.SUBMISSION_INCOMPLETE,
    );
  }

  const row = await repo.submitJobCard(jobCardId, actorId);
  if (row) return toJobCardDto(row, false);

  // Null means someone else submitted between the check above and the write.
  // That is the idempotent answer too, not an error.
  const current = await repo.findJobCardById(jobCardId);
  if (!current) throw new AppError(404, "Job card not found");
  return toJobCardDto(current, false);
}

/**
 * A card's status history.
 *
 * Named `…For` because `listJobCardEvents` is the repository function this
 * wraps, and importing both under one name in a route file is the kind of
 * ambiguity that ships a bug. 404s on an unknown card rather than answering
 * with an empty list: "no such card" and "this card has no history" are
 * different answers, and only one of them is true of a card that never existed.
 */
export async function listJobCardEventsFor(jobCardId: string): Promise<JobCardEventDto[]> {
  const card = await repo.findJobCardAccessRow(jobCardId);
  if (!card) throw new AppError(404, "Job card not found");

  return (await listJobCardEvents(jobCardId)).map((row) => ({
    id: row.id,
    from_status: row.from_status,
    to_status: row.to_status,
    actor_user_id: row.actor_user_id,
    note: row.note,
    created_at: row.created_at.toISOString(),
  }));
}
