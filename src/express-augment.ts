import { Role } from "./types";
import { DepotRow } from "./db/depots.repo";
import { JobCardAccessRow } from "./db/jobCards.repo";

declare global {
  // Augmenting Express's Request is only expressible by reopening its
  // namespace — there is no ES module form of this declaration, so the rule
  // is disabled for this block rather than repo-wide.
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      user?: { id: string; role: Role };
      /** Set by requireDepotAccess: the depot this request is scoped to. */
      depot?: DepotRow;
      /** Set by requireUnlockedJobCard: identity and lock state of the target card. */
      jobCardAccess?: JobCardAccessRow;
    }
  }
}

export {};
