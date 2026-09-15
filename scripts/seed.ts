import bcrypt from "bcryptjs";
import { pool } from "../src/db/pool";
import { findUserByEmail, createUser } from "../src/db/users.repo";

const SALT_ROUNDS = 10;

async function run(): Promise<void> {
  const email = process.env.SEED_SUPERUSER_EMAIL;
  const password = process.env.SEED_SUPERUSER_PASSWORD;

  if (!email || !password) {
    throw new Error(
      "Missing SEED_SUPERUSER_EMAIL / SEED_SUPERUSER_PASSWORD in your .env file.",
    );
  }

  const existing = await findUserByEmail(email);
  if (existing) {
    console.log(`Superuser already exists: ${email} (skipping)`);
    return;
  }

  const passwordHash = await bcrypt.hash(password, SALT_ROUNDS);
  const user = await createUser({
    email,
    passwordHash,
    role: "SUPERUSER",
  });

  console.log(`Created superuser: ${user.email} (id: ${user.id})`);
}

run()
  .catch((err) => {
    console.error("Seed failed:", err);
    process.exitCode = 1;
  })
  .finally(async () => {
    await pool.end();
  });
