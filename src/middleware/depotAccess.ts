/**
 * Depot scoping and job-card locking.
 *
 * Every rule about *which* depot a caller may touch, and *whether* a card is
 * still writable, lives here. Route handlers therefore never repeat a scoping
 * check, and no handler can forget one.
 */

import { NextFunction, Request, Response } from "express";
import "../express-augment";
import { AppError, ERROR_CODES } from "./errors";
import { findActiveDepotForUser, findDepotById } from "../db/depots.repo";
import { findJobCardAccessRow } from "../db/jobCards.repo";
import { Role } from "../types";
import { assertUuid } from "../utils/uuid";

/** Roles that read and act across depots rather than being scoped to one. */
const CROSS_DEPOT_ROLES: Role[] = ["ADMIN", "SUPERUSER"];

/**
 * Resolves the depot this request targets — from `:depotId`, from the job
 * card named by `:jobCardId`, or from both — and refuses it unless the
 * caller's active membership matches. The depot is never trusted from the
 * path alone: a caller passing another depot's id gets 403, not that depot's
 * data.
 *
 * When both params are present (a route shaped like
 * `/depots/:depotId/job-cards/:jobCardId`), the card must also belong to that
 * depot — otherwise this would check the caller's own depot and then hand the
 * handler a job card living in a different one. A mismatch is reported as 404
 * rather than 403 so a caller scoped to another depot cannot learn the card
 * exists elsewhere.
 */
export async function requireDepotAccess(
  req: Request,
  _res: Response,
  next: NextFunction,
): Promise<void> {
  const user = req.user;
  if (!user) throw new AppError(401, "Missing or invalid Authorization header");

  let depotId: string;

  if (req.params.depotId && req.params.jobCardId) {
    depotId = assertUuid(req.params.depotId, "depotId");
    const card = await findJobCardAccessRow(
      assertUuid(req.params.jobCardId, "jobCardId"),
    );
    if (!card || card.depot_id !== depotId) {
      throw new AppError(404, "Job card not found");
    }
    req.jobCardAccess = card;
  } else if (req.params.depotId) {
    depotId = assertUuid(req.params.depotId, "depotId");
  } else if (req.params.jobCardId) {
    const card = await findJobCardAccessRow(
      assertUuid(req.params.jobCardId, "jobCardId"),
    );
    if (!card) throw new AppError(404, "Job card not found");
    req.jobCardAccess = card;
    depotId = card.depot_id;
  } else {
    throw new AppError(500, "requireDepotAccess used on a route with no depot in scope");
  }

  const depot = await findDepotById(depotId);
  if (!depot) throw new AppError(404, "Depot not found");

  if (!CROSS_DEPOT_ROLES.includes(user.role)) {
    const active = await findActiveDepotForUser(user.id);
    if (!active || active.id !== depot.id) {
      throw new AppError(
        403,
        "Your account is not assigned to this depot",
        undefined,
        ERROR_CODES.DEPOT_FORBIDDEN,
      );
    }
  }

  // Ordering matters: this runs after the membership check, so a caller with no
  // business at this depot gets DEPOT_FORBIDDEN and never learns whether the
  // depot is open — probing UUIDs must not reveal depot state.
  //
  // Keyed on method rather than role. A depot an admin can still write to is
  // not closed; the way back is to re-enable it, not to work around it. Reads
  // stay open so submitted cards remain viewable and auditable.
  if (depot.is_disabled && req.method !== "GET" && req.method !== "HEAD") {
    throw new AppError(
      403,
      "This depot is closed to new work",
      undefined,
      ERROR_CODES.DEPOT_DISABLED,
    );
  }

  req.depot = depot;
  next();
}

/**
 * Refuses any mutating request against a submitted card. Reads `locked_at`
 * rather than comparing against a list of statuses, so a new status added
 * later cannot accidentally reopen a frozen card.
 *
 * Must run after requireDepotAccess, which has usually already loaded the row.
 */
export async function requireUnlockedJobCard(
  req: Request,
  _res: Response,
  next: NextFunction,
): Promise<void> {
  const card =
    req.jobCardAccess ??
    (await findJobCardAccessRow(assertUuid(req.params.jobCardId, "jobCardId")));

  if (!card) throw new AppError(404, "Job card not found");
  if (card.locked_at) {
    throw new AppError(
      409,
      "This job card has been submitted and is read-only",
      undefined,
      ERROR_CODES.JOB_CARD_LOCKED,
    );
  }

  req.jobCardAccess = card;
  next();
}
