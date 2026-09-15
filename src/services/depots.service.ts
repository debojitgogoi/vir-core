import * as repo from "../db/depots.repo";
import { AppError } from "../middleware/errors";
import { CreateDepotInput, PatchDepotInput } from "../schemas/depot.schemas";
import { DepotDto, DepotMemberDto, Paginated } from "../types";
import { generateSlugId } from "../utils/slug-id";
import { paginate } from "../utils/pagination";
import { assertUuid } from "../utils/uuid";

export function toDepotDto(row: repo.DepotRow): DepotDto {
  return {
    id: row.id,
    slug_id: row.slug_id,
    code: row.code,
    name: row.name,
    timezone: row.timezone,
    address: row.address,
    is_disabled: row.is_disabled,
  };
}

/**
 * Bodies arrive already parsed by `createDepotSchema` / `patchDepotSchema` at
 * the route edge: trimmed, code upper-cased, blanks turned to null. Nothing
 * here re-validates them. The hand-rolled `input.name?.trim()` this replaced
 * turned a non-string body value into a TypeError and a 500.
 */
export async function createDepot(input: CreateDepotInput): Promise<DepotDto> {
  const { code, name } = input;

  if (await repo.findDepotByCode(code)) {
    throw new AppError(409, "A depot with this code already exists");
  }

  let row: repo.DepotRow;
  try {
    row = await repo.insertDepot({
      slugId: await generateSlugId(),
      code,
      name,
      timezone: input.timezone,
      address: input.address ?? null,
    });
  } catch (err) {
    // The pre-check above handles the common case with a clean 409, but two
    // concurrent requests for the same code (or a slug_id collision) can both
    // pass it — this catches the resulting unique violation rather than
    // letting it surface as an unhandled 500.
    if ((err as { code?: string }).code === "23505") {
      throw new AppError(409, "A depot with this code already exists");
    }
    throw err;
  }
  return toDepotDto(row);
}

export async function listDepotsPage(paging: {
  limit: number;
  offset: number;
  includeDisabled?: boolean;
}): Promise<Paginated<DepotDto>> {
  const { rows, total } = await repo.listDepots(paging);
  return paginate(rows.map(toDepotDto), total, paging.limit, paging.offset);
}

export async function getDepotById(id: string): Promise<DepotDto> {
  const row = await repo.findDepotById(id);
  if (!row) throw new AppError(404, "Depot not found");
  return toDepotDto(row);
}

/**
 * `address` cannot yet be cleared: `repo.updateDepot` still writes with
 * COALESCE, which cannot express "set this to NULL", so an explicit null is
 * treated as "leave alone". Job cards got the merge-patch builder in Phase 2;
 * carrying depots over to it is recorded in the Phase 3 carry-over.
 */
export async function updateDepotById(
  id: string,
  patch: PatchDepotInput,
): Promise<DepotDto> {
  const row = await repo.updateDepot(id, {
    name: patch.name,
    timezone: patch.timezone,
    address: patch.address ?? undefined,
    isDisabled: patch.is_disabled,
  });
  if (!row) throw new AppError(404, "Depot not found");
  return toDepotDto(row);
}

function toMemberDto(row: repo.DepotMemberWithUser): DepotMemberDto {
  return {
    user_id: row.user_id,
    name: row.name,
    email: row.email,
    role: row.role,
    assigned_at: row.assigned_at.toISOString(),
  };
}

export async function listMembers(depotId: string): Promise<DepotMemberDto[]> {
  await getDepotById(depotId); // 404s when the depot does not exist
  const rows = await repo.listActiveMembers(depotId);
  return rows.map(toMemberDto);
}

export async function assignMember(
  depotId: string,
  userId: unknown,
): Promise<DepotMemberDto[]> {
  const validUserId = assertUuid(userId, "user_id");
  await getDepotById(depotId);

  try {
    await repo.assignUserToDepot(depotId, validUserId);
  } catch (err) {
    // 23503 is a foreign-key violation, which here can only mean the user id
    // does not exist — the depot was verified a moment ago.
    if ((err as { code?: string }).code === "23503") {
      throw new AppError(404, "User not found");
    }
    throw err;
  }

  return listMembers(depotId);
}

export async function removeMember(depotId: string, userId: string): Promise<void> {
  await getDepotById(depotId);
  const removed = await repo.deactivateMembership(depotId, userId);
  if (!removed) {
    throw new AppError(404, "That user is not an active member of this depot");
  }
}

/** Used by requireDepotAccess; returns null rather than throwing. */
export async function getActiveDepotForUser(userId: string): Promise<DepotDto | null> {
  const row = await repo.findActiveDepotForUser(userId);
  return row ? toDepotDto(row) : null;
}
