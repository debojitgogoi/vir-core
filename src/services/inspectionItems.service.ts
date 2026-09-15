/**
 * Inspection line items: the diagnosis half of a job card.
 *
 * This service owns three things the repository cannot: the integrity rules
 * no foreign key can express (a subview must belong to its main view, and a
 * main view to the card's equipment type), the custom field snapshot, and the
 * DRAFT -> IN_INSPECTION transition that the first successful item write
 * triggers.
 */

import { pool } from "../db/pool";
import * as repo from "../db/inspectionItems.repo";
import { insertJobCardEvent } from "../db/jobCardEvents.repo";
import { findJobCardAccessRow } from "../db/jobCards.repo";
import { findMediaAssetById, MediaAssetRow } from "../db/media.repo";
import { AppError, ERROR_CODES } from "../middleware/errors";
import { CustomFieldAnswerInput, validateCustomFields } from "./customFields";
import * as mediaService from "./media.service";
import {
  CreateInspectionItemInput,
  PatchInspectionItemInput,
} from "../schemas/inspectionItem.schemas";
import { InspectionItemCustomField, InspectionItemDto, MediaAssetDto } from "../types";
import { signMediaToken } from "../utils/assetToken";

const pgCode = (err: unknown): string | undefined => (err as { code?: string }).code;

/**
 * Who is asking, and the depot their request resolved to. The same shape
 * media.service uses, aliased rather than redefined so the two cannot drift.
 */
export type ItemMediaActor = mediaService.MediaActor;

export function toInspectionItemDto(row: repo.InspectionItemRow): InspectionItemDto {
  return {
    id: row.id,
    job_card_id: row.job_card_id,
    main_view_id: row.main_view_id,
    subview_id: row.subview_id,
    component_id: row.component_id,
    condition_rating: row.condition_rating,
    notes: row.notes,
    custom_fields: row.custom_fields as InspectionItemCustomField[],
    display_order: row.display_order,
    client_uuid: row.client_uuid,
    damage_code_ids: row.damage_code_ids,
    repair_code_ids: row.repair_code_ids,
    created_by: row.created_by,
    created_at: row.created_at.toISOString(),
    updated_at: row.updated_at.toISOString(),
  };
}

async function loadCard(jobCardId: string) {
  const card = await findJobCardAccessRow(jobCardId);
  if (!card) throw new AppError(404, "Job card not found");
  return card;
}

/**
 * The card's equipment type, which the locating chain must agree with. Read
 * separately from the access row so the middleware's projection stays narrow.
 */
async function equipmentTypeOf(jobCardId: string): Promise<string> {
  const { rows } = await pool.query<{ equipment_type_id: string }>(
    "SELECT equipment_type_id FROM job_cards WHERE id = $1",
    [jobCardId],
  );
  return rows[0].equipment_type_id;
}

/**
 * Checks the parts of the locating chain no foreign key can express.
 *
 * Master data is per equipment type, so an item pointing at another type's
 * main view is a row that renders blank on every client and reports against
 * the wrong form. Likewise a subview whose parent is not the main view given.
 * Both are silent corruptions rather than errors, which is why they are
 * checked here rather than left to the database.
 *
 * @param violations collected rather than thrown, so one request reports every
 * problem it has.
 */
async function checkLocatingChain(
  equipmentTypeId: string,
  input: { main_view_id?: string | null; subview_id?: string | null },
  violations: string[],
  at: string,
): Promise<void> {
  const mainViewId = input.main_view_id ?? null;
  const subviewId = input.subview_id ?? null;

  if (mainViewId) {
    const { rows } = await pool.query(
      "SELECT 1 FROM main_views WHERE id = $1 AND equipment_type_id = $2",
      [mainViewId, equipmentTypeId],
    );
    if (rows.length === 0) {
      violations.push(`${at}main_view_id: does not belong to this card's equipment type`);
    }
  }

  if (subviewId) {
    // Joined to the subview's own main view rather than queried alone: a
    // subview belongs to an equipment type through its main view, and that
    // must hold whether or not the caller also sent main_view_id.
    const { rows } = await pool.query<{ main_view_id: string; equipment_type_id: string }>(
      `SELECT s.main_view_id, mv.equipment_type_id
         FROM subviews s
         JOIN main_views mv ON mv.id = s.main_view_id
        WHERE s.id = $1`,
      [subviewId],
    );
    if (rows.length === 0) {
      violations.push(`${at}subview_id: no such subview`);
    } else if (rows[0].equipment_type_id !== equipmentTypeId) {
      violations.push(`${at}subview_id: does not belong to this card's equipment type`);
    } else if (mainViewId && rows[0].main_view_id !== mainViewId) {
      violations.push(`${at}subview_id: does not belong to the given main_view_id`);
    }
  }
}

/**
 * Resolves one item's custom field answers against its subview's definitions.
 *
 * Answers require a `subview_id`: definitions are per subview, so without one
 * there is nothing to validate against and storing them would mean storing
 * unvalidated client text under names the client chose.
 */
async function resolveCustomFields(
  answers: CustomFieldAnswerInput[] | undefined,
  subviewId: string | null | undefined,
  at: string,
): Promise<InspectionItemCustomField[]> {
  if (!answers || answers.length === 0) return [];

  if (!subviewId) {
    throw new AppError(
      400,
      "Custom field answers need a subview",
      [`${at}subview_id: required when custom_fields are given`],
      ERROR_CODES.VALIDATION_ERROR,
    );
  }

  const definitions = await repo.findSubviewFieldDefinitions(subviewId);
  return validateCustomFields(answers, definitions);
}

/**
 * Moves a DRAFT card to IN_INSPECTION and records the event.
 *
 * The UPDATE carries the guard rather than a read-then-write, so two
 * simultaneous first writes produce one transition and one event row instead
 * of two. Only a card this call actually moved gets an event.
 *
 * The status change and its event are one transaction: a crash between two
 * separate statements used to leave a card permanently IN_INSPECTION with no
 * event to show for it, and the `WHERE status = 'DRAFT'` guard meant no later
 * write could ever retry it. Committing them together makes that window
 * disappear rather than just narrowing it.
 */
async function transitionToInInspection(jobCardId: string, actorId: string): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    const { rowCount } = await client.query(
      "UPDATE job_cards SET status = 'IN_INSPECTION' WHERE id = $1 AND status = 'DRAFT'",
      [jobCardId],
    );

    if (rowCount) {
      await insertJobCardEvent(
        {
          jobCardId,
          fromStatus: "DRAFT",
          toStatus: "IN_INSPECTION",
          actorUserId: actorId,
          note: "First inspection item recorded",
        },
        client,
      );
    }

    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}

/** A foreign-key or replay-collision violation is a bad request, not a 500. */
function mapInsertError(err: unknown): never {
  if (pgCode(err) === "23503") {
    throw new AppError(
      400,
      "A damage or repair code does not exist",
      ["damage_code_ids/repair_code_ids: must reference existing codes"],
      ERROR_CODES.VALIDATION_ERROR,
    );
  }
  // A batch where only some client_uuids collide is not a full replay —
  // findReplay above already ruled that out — so the unique violation reaches
  // here. That is a request the client should retry, not a server fault.
  if (pgCode(err) === "23505") {
    throw new AppError(
      409,
      "Some items in this batch were already saved under a different combination of items; resend only the new items, or resend the exact original batch",
    );
  }
  throw err;
}

export async function createInspectionItems(
  jobCardId: string,
  inputs: CreateInspectionItemInput[],
  actorId: string,
): Promise<InspectionItemDto[]> {
  await loadCard(jobCardId);
  const equipmentTypeId = await equipmentTypeOf(jobCardId);

  // A replayed batch: if every key is one we already hold, hand back what we
  // stored rather than colliding. Mirrors jobCards.service.createJobCard.
  const replayed = await findReplay(jobCardId, inputs);
  if (replayed) return replayed;

  const violations: string[] = [];
  const prepared: repo.InsertInspectionItemInput[] = [];
  let nextOrder = (await repo.findMaxDisplayOrder(jobCardId)) + 1;

  for (const [index, input] of inputs.entries()) {
    // Indexed only for a batch: "0.subview_id" on a single-object request would
    // name an index the client never sent. The dotted shape is what fromZod
    // emits, so one endpoint never answers in two notations.
    const at = inputs.length > 1 ? `${index}.` : "";

    // Captured before the call so a check against *this* item's own violation
    // count, not the batch's cumulative one — otherwise one bad item earlier
    // in the batch silently skips custom-field validation for every item
    // after it, and each gets reported only on a later round trip.
    const violationsBefore = violations.length;
    await checkLocatingChain(equipmentTypeId, input, violations, at);

    // The chain is checked before the fields so a wrong subview is reported as
    // a wrong subview, not as fifteen unknown fields.
    const customFields =
      violations.length > violationsBefore
        ? []
        : await resolveCustomFields(input.custom_fields, input.subview_id, at);

    prepared.push({
      mainViewId: input.main_view_id ?? null,
      subviewId: input.subview_id ?? null,
      componentId: input.component_id ?? null,
      conditionRating: input.condition_rating ?? null,
      notes: input.notes ?? null,
      customFields,
      displayOrder: input.display_order ?? nextOrder++,
      clientUuid: input.client_uuid ?? null,
      damageCodeIds: input.damage_code_ids ?? [],
      repairCodeIds: input.repair_code_ids ?? [],
    });
  }

  if (violations.length > 0) {
    throw new AppError(
      400,
      "Inspection item validation failed",
      violations,
      ERROR_CODES.VALIDATION_ERROR,
    );
  }

  let rows: repo.InspectionItemRow[];
  try {
    rows = await repo.insertInspectionItems(jobCardId, prepared, actorId);
  } catch (err) {
    // A concurrent request may have won the race on the same client_uuid.
    if (pgCode(err) === "23505") {
      const existing = await findReplay(jobCardId, inputs);
      if (existing) return existing;
    }
    mapInsertError(err);
  }

  await transitionToInInspection(jobCardId, actorId);
  return rows.map(toInspectionItemDto);
}

/**
 * The idempotency seam: a batch every one of whose items carries a
 * `client_uuid` we already stored is a retry, and returns what we stored.
 *
 * A partial match is deliberately not treated as a replay — a batch where some
 * keys are new is a different request, and inserting only the new ones would
 * make the response disagree with what the client sent.
 */
async function findReplay(
  jobCardId: string,
  inputs: CreateInspectionItemInput[],
): Promise<InspectionItemDto[] | null> {
  const keys = inputs.map((input) => input.client_uuid);
  if (keys.some((key) => !key)) return null;

  const found = await Promise.all(
    keys.map((key) => repo.findInspectionItemByClientUuid(jobCardId, key as string)),
  );
  if (found.some((row) => row === null)) return null;

  return found.map((row) => toInspectionItemDto(row as repo.InspectionItemRow));
}

export async function listInspectionItems(jobCardId: string): Promise<InspectionItemDto[]> {
  await loadCard(jobCardId);
  return (await repo.listInspectionItems(jobCardId)).map(toInspectionItemDto);
}

/**
 * Loads an item and refuses one belonging to another card.
 *
 * Without the card check, item ids would be a cross-card read channel that
 * requireDepotAccess — which scopes on the card in the path — cannot see. 404
 * rather than 403, so guessing ids reveals nothing.
 */
async function loadItem(jobCardId: string, itemId: string): Promise<repo.InspectionItemRow> {
  await loadCard(jobCardId);
  const row = await repo.findInspectionItem(itemId);
  if (!row || row.job_card_id !== jobCardId) {
    throw new AppError(404, "Inspection item not found");
  }
  return row;
}

export async function getInspectionItem(
  jobCardId: string,
  itemId: string,
): Promise<InspectionItemDto> {
  return toInspectionItemDto(await loadItem(jobCardId, itemId));
}

export async function updateInspectionItem(
  jobCardId: string,
  itemId: string,
  patch: PatchInspectionItemInput,
): Promise<InspectionItemDto> {
  const existing = await loadItem(jobCardId, itemId);
  const equipmentTypeId = await equipmentTypeOf(jobCardId);

  const violations: string[] = [];
  // The chain is checked against the item as it will be, not as it was: a
  // patch may move the subview, the main view, or both at once.
  await checkLocatingChain(
    equipmentTypeId,
    {
      main_view_id: "main_view_id" in patch ? patch.main_view_id : existing.main_view_id,
      subview_id: "subview_id" in patch ? patch.subview_id : existing.subview_id,
    },
    violations,
    "",
  );

  if (violations.length > 0) {
    throw new AppError(
      400,
      "Inspection item validation failed",
      violations,
      ERROR_CODES.VALIDATION_ERROR,
    );
  }

  const columns: Record<string, unknown> = {};
  for (const key of [
    "main_view_id",
    "subview_id",
    "component_id",
    "condition_rating",
    "notes",
    "display_order",
  ] as const) {
    if (key in patch) columns[key] = patch[key] ?? null;
  }

  if ("custom_fields" in patch) {
    // Re-validated against whichever subview the item ends up on, so moving an
    // item and re-answering it in one request cannot store answers from the
    // subview it left.
    const subviewId = "subview_id" in patch ? patch.subview_id : existing.subview_id;
    columns.custom_fields = await resolveCustomFields(patch.custom_fields, subviewId, "");
  }

  let row: repo.InspectionItemRow | null;
  try {
    row = await repo.updateInspectionItem(itemId, columns, {
      damageCodeIds: patch.damage_code_ids,
      repairCodeIds: patch.repair_code_ids,
    });
  } catch (err) {
    mapInsertError(err);
  }

  if (!row) throw new AppError(404, "Inspection item not found");
  return toInspectionItemDto(row);
}

export async function deleteInspectionItem(jobCardId: string, itemId: string): Promise<void> {
  await loadItem(jobCardId, itemId);
  await repo.deleteInspectionItem(itemId);
}

// --- Line-item photographs -------------------------------------------------
//
// Everything about media except the link table is Phase 3's and is reused
// unchanged: registration, upload, checksum verification and the signed
// download tokens. These three functions are the job-card equivalents in
// media.service.ts with one difference — they resolve the item and assert it
// belongs to the card in the path first, so an item id cannot reach across
// cards.

/**
 * Attaches an already-uploaded asset to a line item.
 *
 * Idempotent: re-attaching the same asset is a retry, not a conflict, so the
 * UNIQUE firing is swallowed exactly as the job-card attach swallows it.
 */
export async function attachMediaToItem(
  jobCardId: string,
  itemId: string,
  mediaId: string,
  actor: mediaService.MediaActor,
): Promise<MediaAssetDto> {
  await loadItem(jobCardId, itemId);

  const asset = await findMediaAssetById(mediaId);
  // 404 rather than 403 for an asset registered elsewhere, so a caller scoped
  // to another depot cannot use the difference to discover that it exists.
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

  try {
    await repo.insertInspectionItemMedia({
      inspectionItemId: itemId,
      mediaAssetId: asset.id,
      displayOrder: (await repo.findMaxItemMediaOrder(itemId)) + 1,
      createdBy: actor.id,
    });
  } catch (err) {
    if (pgCode(err) !== "23505") throw err;
  }

  return mediaService.toMediaAssetDto(asset);
}

export async function detachMediaFromItem(
  jobCardId: string,
  itemId: string,
  mediaId: string,
): Promise<void> {
  await loadItem(jobCardId, itemId);
  const removed = await repo.deleteInspectionItemMedia(itemId, mediaId);
  if (!removed) throw new AppError(404, "That media is not attached to this item");
  // The asset row and its bytes stay: they may be attached elsewhere, and
  // content-addressed storage is only ever swept by a reaper that has checked
  // every link first.
}

/**
 * The item's photographs, each with a short-lived signed URL ready to display.
 *
 * No depot check: the caller has already been through requireDepotAccess for
 * this card, and these assets are attached to an item on it.
 */
export async function listItemMediaWithUrls(
  jobCardId: string,
  itemId: string,
  actorId: string,
): Promise<(MediaAssetDto & { display_order: number; url: string; expires_at: string })[]> {
  await loadItem(jobCardId, itemId);
  const rows = await repo.listInspectionItemMedia(itemId);

  return rows.map((row) => {
    const signed = signMediaToken(row.id, actorId);
    // Reuses media.service's own mapper rather than a second one that could
    // disagree about a URL shape — the same reason the signature module reused
    // toJobCardDto instead of writing its own.
    return {
      ...mediaService.toMediaAssetDto(row as unknown as MediaAssetRow),
      display_order: row.display_order,
      url: `/assets/media/${signed.token}`,
      expires_at: signed.expiresAt,
    };
  });
}
