import * as repo from "../db/jobCards.repo";
import { getEquipmentPrefix, getEquipmentType } from "../db/equipment.repo";
import { AppError, ERROR_CODES } from "../middleware/errors";
import { CreateJobCardInput, PatchJobCardInput } from "../schemas/jobCard.schemas";
import {
  EquipmentForm,
  EquipmentSize,
  GensetStatus,
  JobCardDirection,
  JobCardDto,
  JobCardStatus,
  Paginated,
  RegistrationStatus,
} from "../types";
import { generateJobNumber } from "../utils/jobNumber";
import { paginate } from "../utils/pagination";

/** How many job_number collisions to ride out before giving up. */
const JOB_NUMBER_ATTEMPTS = 5;

const iso = (value: Date | null): string | null => (value ? value.toISOString() : null);

/** A card is editable while it is unlocked. Role scoping happens in middleware. */
const isEditable = (row: repo.JobCardRow): boolean => row.locked_at === null;

const pgCode = (err: unknown): string | undefined => (err as { code?: string }).code;
const pgConstraint = (err: unknown): string | undefined =>
  (err as { constraint?: string }).constraint;

function validationError(violation: string): AppError {
  return new AppError(
    400,
    "Request validation failed",
    [violation],
    ERROR_CODES.VALIDATION_ERROR,
  );
}

/** The only two foreign keys a client can supply on this resource. */
const FK_VIOLATION =
  "equipment_type_id or equipment_prefix_id does not refer to an existing record";

/**
 * `prefix_text` is meant to be a snapshot of the chosen `equipment_prefix_id`,
 * not independent client input — otherwise a client can set a prefix id from
 * one equipment category and free text that disagrees with it, and that
 * mismatch ends up baked into the customer's signed acknowledgment along with
 * everything else `equipment_prefix_id`/`prefix_text` carry.
 *
 * Same shape of check as `checkLocatingChain` in inspectionItems.service.ts:
 * verify the referenced row belongs where the card says it does, then let the
 * server's own copy of it win over whatever the client sent.
 */
async function resolvePrefixSnapshot(
  equipmentTypeId: string,
  equipmentPrefixId: string,
): Promise<string> {
  const equipmentType = await getEquipmentType(equipmentTypeId);
  if (!equipmentType) throw validationError("equipment_type_id: no such equipment type");

  const prefix = await getEquipmentPrefix(equipmentPrefixId);
  if (!prefix) throw validationError("equipment_prefix_id: no such prefix");

  if (prefix.equipment_category_id !== equipmentType.equipment_category_id) {
    throw validationError(
      "equipment_prefix_id: does not belong to this card's equipment category",
    );
  }

  return prefix.prefix_name;
}

export function toJobCardDto(row: repo.JobCardRow, canEdit: boolean): JobCardDto {
  return {
    id: row.id,
    job_number: row.job_number,
    depot_id: row.depot_id,
    status: row.status,
    client_uuid: row.client_uuid,

    direction: row.direction,
    equipment_type_id: row.equipment_type_id,
    trucker_name: row.trucker_name,
    location: row.location,
    inspected_at: iso(row.inspected_at),
    equipment_prefix_id: row.equipment_prefix_id,
    prefix_text: row.prefix_text,
    container_number: row.container_number,
    chassis_number: row.chassis_number,
    genset_status: row.genset_status as GensetStatus | null,
    size: row.size as EquipmentSize | null,
    equipment_form: row.equipment_form as EquipmentForm | null,
    serial_number: row.serial_number,
    license_plate: row.license_plate,
    license_state: row.license_state,
    license_expiry_date: row.license_expiry_date,
    registration_status: row.registration_status as RegistrationStatus | null,
    pool_point: row.pool_point,
    customer_name: row.customer_name,
    redelivery_release_no: row.redelivery_release_no,
    customer_account_no: row.customer_account_no,
    on_hire_date: row.on_hire_date,
    scac_code: row.scac_code,
    fhwa_sticker_date: row.fhwa_sticker_date,
    driver_name: row.driver_name,
    manufacture_year: row.manufacture_year,

    created_by: row.created_by,
    updated_by: row.updated_by,
    submitted_by: row.submitted_by,
    submitted_at: iso(row.submitted_at),
    locked_at: iso(row.locked_at),
    can_edit: canEdit,
    created_at: row.created_at.toISOString(),
    updated_at: row.updated_at.toISOString(),
  };
}

const asDto = (row: repo.JobCardRow): JobCardDto => toJobCardDto(row, isEditable(row));

export async function createJobCard(
  depotId: string,
  input: CreateJobCardInput,
  actorId: string,
): Promise<{ card: JobCardDto; created: boolean }> {
  const { client_uuid: clientUuid, ...values } = input;

  // Fast path for the common replay. The race — two retries arriving together —
  // is caught by the partial unique index below, so this is an optimisation
  // rather than the correctness guarantee.
  if (clientUuid) {
    const existing = await repo.findJobCardByClientUuid(depotId, clientUuid);
    if (existing) return { card: asDto(existing), created: false };
  }

  if (values.equipment_prefix_id) {
    values.prefix_text = await resolvePrefixSnapshot(
      values.equipment_type_id,
      values.equipment_prefix_id,
    );
  }

  for (let attempt = 0; attempt < JOB_NUMBER_ATTEMPTS; attempt += 1) {
    try {
      const row = await repo.insertJobCard({
        jobNumber: await generateJobNumber(),
        depotId,
        clientUuid: clientUuid ?? null,
        createdBy: actorId,
        values: values as Record<string, unknown>,
      });
      return { card: asDto(row), created: true };
    } catch (err) {
      if (pgCode(err) === "23505" && pgConstraint(err) === "ux_job_cards_client_uuid") {
        // Two retries of the same offline create raced. The winner's row is the
        // answer; this call is the replay it was always meant to be.
        const existing = clientUuid
          ? await repo.findJobCardByClientUuid(depotId, clientUuid)
          : null;
        if (existing) return { card: asDto(existing), created: false };
        throw err;
      }
      if (pgCode(err) === "23505" && pgConstraint(err) === "job_cards_job_number_key") {
        continue; // A 36^8 collision. Draw again.
      }
      if (pgCode(err) === "23503") throw validationError(FK_VIOLATION);
      throw err;
    }
  }

  throw new AppError(500, "Could not allocate a unique job number");
}

export async function getJobCardById(id: string): Promise<JobCardDto> {
  const row = await repo.findJobCardById(id);
  if (!row) throw new AppError(404, "Job card not found");
  return asDto(row);
}

export interface ListJobCardsInput {
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

export async function listJobCardsPage(
  input: ListJobCardsInput,
): Promise<Paginated<JobCardDto>> {
  const { rows, total } = await repo.listJobCards(input);
  return paginate(rows.map(asDto), total, input.limit, input.offset);
}

/**
 * An HTTP-date carries one-second resolution while `updated_at` carries
 * microseconds, so a client echoing back the timestamp it just read is always
 * fractionally behind. Comparing truncated seconds is what makes the header
 * usable at all — comparing raw instants would reject every honest request.
 */
function assertNotStale(row: repo.JobCardRow, ifUnmodifiedSince: string): void {
  const headerMs = Date.parse(ifUnmodifiedSince);
  if (Number.isNaN(headerMs)) {
    throw validationError("If-Unmodified-Since must be a valid HTTP date");
  }
  if (Math.floor(row.updated_at.getTime() / 1000) > Math.floor(headerMs / 1000)) {
    throw new AppError(
      409,
      "This job card changed since you loaded it; reload before saving",
      undefined,
      ERROR_CODES.STALE_WRITE,
    );
  }
}

export async function updateJobCardById(
  id: string,
  patch: PatchJobCardInput,
  actorId: string,
  ifUnmodifiedSince?: string,
): Promise<JobCardDto> {
  const current = await repo.findJobCardById(id);
  if (!current) throw new AppError(404, "Job card not found");

  if (ifUnmodifiedSince) assertNotStale(current, ifUnmodifiedSince);

  // The identifier rule spans two columns, so it can only be judged against the
  // row the patch would produce. Checking it here rather than letting the SQL
  // CHECK fire keeps the failure a named validation error instead of a 500.
  const merged = { ...current, ...patch };
  if (!merged.container_number && !merged.chassis_number) {
    throw validationError("at least one of container_number or chassis_number is required");
  }

  // equipment_type_id drives the whole locating chain an inspection item is
  // checked against (main_view -> subview -> component). Once inspection has
  // started the card is no longer DRAFT, so changing it out from under
  // existing items would leave them pointing at a foreign equipment type with
  // nothing left to re-validate them.
  if (
    Object.prototype.hasOwnProperty.call(patch, "equipment_type_id") &&
    current.status !== "DRAFT"
  ) {
    throw validationError(
      "equipment_type_id cannot be changed once inspection has started",
    );
  }

  // Re-validated whenever either half of the pair is touched, against the
  // *merged* row — a patch that only sends equipment_type_id must still catch
  // an existing prefix that no longer belongs to it. When a prefix applies,
  // its own prefix_name wins over anything the client sent for prefix_text.
  if (
    merged.equipment_prefix_id &&
    (Object.prototype.hasOwnProperty.call(patch, "equipment_prefix_id") ||
      Object.prototype.hasOwnProperty.call(patch, "equipment_type_id"))
  ) {
    patch = {
      ...patch,
      prefix_text: await resolvePrefixSnapshot(
        merged.equipment_type_id,
        merged.equipment_prefix_id,
      ),
    };
  }

  try {
    const row = await repo.updateJobCard(id, patch as Record<string, unknown>, actorId);
    if (!row) {
      // repo.updateJobCard's WHERE also excludes a locked row, so "no row
      // came back" is ambiguous between "gone" and "submitted since we read
      // it" — a re-read tells the two apart.
      const stillThere = await repo.findJobCardById(id);
      if (stillThere) {
        throw new AppError(
          409,
          "This job card has been submitted and is read-only",
          undefined,
          ERROR_CODES.JOB_CARD_LOCKED,
        );
      }
      throw new AppError(404, "Job card not found");
    }
    return asDto(row);
  } catch (err) {
    if (pgCode(err) === "23503") throw validationError(FK_VIOLATION);
    if (pgCode(err) === "23514") {
      throw validationError(`the update violates constraint ${pgConstraint(err)}`);
    }
    throw err;
  }
}
