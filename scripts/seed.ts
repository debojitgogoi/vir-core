import bcrypt from "bcryptjs";
import { pool } from "../src/db/pool";
import { findUserByEmail, createUser } from "../src/db/users.repo";
import { findDepotByCode } from "../src/db/depots.repo";
import {
  assignMember,
  createDepot,
  listMembers,
} from "../src/services/depots.service";

const SALT_ROUNDS = 10;

/**
 * The depot every seeded environment gets.
 *
 * A user with no active membership cannot create a job card: `GET /me/depot`
 * returns null, the client aborts the create, and the UI shows nothing. A seed
 * that stops at the user therefore leaves the app dead on the home screen.
 */
const DEPOT = {
  code: "SYD1",
  name: "Sydney Depot",
  timezone: "Australia/Sydney",
};

async function ensureSuperuser(email: string, password: string) {
  const existing = await findUserByEmail(email);
  if (existing) {
    console.log(`Superuser already exists: ${email} (skipping)`);
    return existing;
  }

  const passwordHash = await bcrypt.hash(password, SALT_ROUNDS);
  const user = await createUser({ email, passwordHash, role: "SUPERUSER" });
  console.log(`Created superuser: ${user.email} (id: ${user.id})`);
  return user;
}

async function ensureDepot() {
  const existing = await findDepotByCode(DEPOT.code);
  if (existing) {
    console.log(`Depot already exists: ${existing.code} (id: ${existing.id})`);
    return existing;
  }

  const depot = await createDepot({ ...DEPOT });
  console.log(`Created depot: ${depot.code} - ${depot.name} (id: ${depot.id})`);
  return depot;
}

async function run(): Promise<void> {
  const email = process.env.SEED_SUPERUSER_EMAIL;
  const password = process.env.SEED_SUPERUSER_PASSWORD;

  if (!email || !password) {
    throw new Error(
      "Missing SEED_SUPERUSER_EMAIL / SEED_SUPERUSER_PASSWORD in your .env file.",
    );
  }

  // Deliberately not short-circuiting on an existing superuser. That guard used
  // to `return`, so any database that already had the user silently never got
  // the depot or the membership below it.
  const user = await ensureSuperuser(email, password);
  const depot = await ensureDepot();

  const members = await listMembers(depot.id);
  if (members.some((member) => member.user_id === user.id)) {
    console.log(`Already a member of ${depot.code} (skipping)`);
  } else {
    await assignMember(depot.id, user.id);
    console.log(`Assigned ${user.email} to depot ${depot.code}`);
  }
}

run()
  .catch((err) => {
    console.error("Seed failed:", err);
    process.exitCode = 1;
  })
  .finally(async () => {
    await pool.end();
  });
