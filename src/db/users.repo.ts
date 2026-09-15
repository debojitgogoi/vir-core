import { pool } from "./pool";
import { Role } from "../types";

export interface UserRow {
  id: string;
  email: string;
  password_hash: string;
  name: string | null;
  role: Role;
  location: string | null;
  profile_completed: boolean;
  employee_id: string | null;
  designation: string | null;
  created_at: Date;
  updated_at: Date;
}

export interface PublicUser {
  id: string;
  email: string;
  name: string | null;
  role: Role;
  location: string | null;
  profileCompleted: boolean;
  employeeId: string | null;
  designation: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export function toPublicUser(row: UserRow): PublicUser {
  return {
    id: row.id,
    email: row.email,
    name: row.name,
    role: row.role,
    location: row.location,
    profileCompleted: row.profile_completed,
    employeeId: row.employee_id,
    designation: row.designation,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function computeProfileCompleted(
  name: string | null | undefined,
  location: string | null | undefined,
): boolean {
  return Boolean(name && name.trim() && location && location.trim());
}

export async function findUserByEmail(email: string): Promise<UserRow | null> {
  const { rows } = await pool.query<UserRow>("SELECT * FROM users WHERE email = $1", [email]);
  return rows[0] ?? null;
}

export async function findUserById(id: string): Promise<UserRow | null> {
  const { rows } = await pool.query<UserRow>("SELECT * FROM users WHERE id = $1", [id]);
  return rows[0] ?? null;
}

export interface CreateUserInput {
  email: string;
  passwordHash: string;
  role: Role;
  name?: string | null;
  location?: string | null;
  employeeId?: string | null;
  designation?: string | null;
}

export async function createUser(input: CreateUserInput): Promise<UserRow> {
  const profileCompleted = computeProfileCompleted(input.name, input.location);
  const { rows } = await pool.query<UserRow>(
    `INSERT INTO users (email, password_hash, name, role, location, profile_completed, employee_id, designation)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
     RETURNING *`,
    [
      input.email,
      input.passwordHash,
      input.name ?? null,
      input.role,
      input.location ?? null,
      profileCompleted,
      input.employeeId ?? null,
      input.designation ?? null,
    ],
  );
  return rows[0];
}

export interface ListUsersFilters {
  role?: Role;
  location?: string;
}

export async function listUsers(filters: ListUsersFilters): Promise<UserRow[]> {
  const clauses: string[] = [];
  const params: unknown[] = [];

  if (filters.role) {
    params.push(filters.role);
    clauses.push(`role = $${params.length}`);
  }
  if (filters.location) {
    params.push(filters.location);
    clauses.push(`location = $${params.length}`);
  }

  const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
  const { rows } = await pool.query<UserRow>(
    `SELECT * FROM users ${where} ORDER BY created_at DESC`,
    params,
  );
  return rows;
}

export interface UpdateUserInput {
  email?: string;
  name?: string | null;
  location?: string | null;
  role?: Role;
  employeeId?: string | null;
  designation?: string | null;
}

export async function updateUser(id: string, patch: UpdateUserInput): Promise<UserRow | null> {
  const current = await findUserById(id);
  if (!current) return null;

  const nextName = patch.name !== undefined ? patch.name : current.name;
  const nextLocation = patch.location !== undefined ? patch.location : current.location;
  const profileCompleted = computeProfileCompleted(nextName, nextLocation);

  const { rows } = await pool.query<UserRow>(
    `UPDATE users SET
       email = COALESCE($2, email),
       name = $3,
       location = $4,
       role = COALESCE($5, role),
       employee_id = COALESCE($6, employee_id),
       designation = COALESCE($7, designation),
       profile_completed = $8,
       updated_at = now()
     WHERE id = $1
     RETURNING *`,
    [
      id,
      patch.email ?? null,
      nextName,
      nextLocation,
      patch.role ?? null,
      patch.employeeId ?? null,
      patch.designation ?? null,
      profileCompleted,
    ],
  );
  return rows[0];
}
