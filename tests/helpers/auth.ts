import jwt from "jsonwebtoken";
import { pool } from "../../src/db/pool";
import { env } from "../../src/config/env";
import { Role } from "../../src/types";

let counter = 0;

export async function createTestUser(opts: {
  role: Role;
  email?: string;
  name?: string;
}): Promise<{ id: string; email: string; role: Role }> {
  counter += 1;
  const email = opts.email ?? `user${counter}@test.local`;
  const { rows } = await pool.query<{ id: string }>(
    `INSERT INTO users (email, password_hash, name, role)
     VALUES ($1, $2, $3, $4) RETURNING id`,
    [email, "not-a-real-hash", opts.name ?? `Test User ${counter}`, opts.role],
  );
  return { id: rows[0].id, email, role: opts.role };
}

/** Full Authorization header value, matching what requireAuth expects. */
export function bearerFor(userId: string, role: Role): string {
  const token = jwt.sign({ sub: userId, role }, env.jwtSecret, { expiresIn: "1h" });
  return `Bearer ${token}`;
}
