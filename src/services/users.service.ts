import bcrypt from "bcryptjs";
import { AppError } from "../middleware/errors";
import { ROLES, Role } from "../types";
import {
  createUser,
  findUserByEmail,
  findUserById,
  listUsers,
  PublicUser,
  toPublicUser,
  updateUser,
} from "../db/users.repo";

function assertValidRole(role: unknown): asserts role is Role {
  if (typeof role !== "string" || !ROLES.includes(role as Role)) {
    throw new AppError(400, `role must be one of: ${ROLES.join(", ")}`);
  }
}

export interface CreateUserRequest {
  email: string;
  password: string;
  role: string;
  name?: string;
  location?: string;
  employeeId?: string;
  designation?: string;
}

export async function createUserByAdmin(input: CreateUserRequest): Promise<PublicUser> {
  if (!input.email || !input.password) {
    throw new AppError(400, "email and password are required");
  }
  assertValidRole(input.role);

  const existing = await findUserByEmail(input.email);
  if (existing) throw new AppError(409, "A user with this email already exists");

  const passwordHash = await bcrypt.hash(input.password, 10);
  const user = await createUser({
    email: input.email,
    passwordHash,
    role: input.role,
    name: input.name ?? null,
    location: input.location ?? null,
    employeeId: input.employeeId ?? null,
    designation: input.designation ?? null,
  });
  return toPublicUser(user);
}

export async function listAllUsers(filters: {
  role?: string;
  location?: string;
}): Promise<PublicUser[]> {
  if (filters.role) assertValidRole(filters.role);
  const rows = await listUsers({
    role: filters.role as Role | undefined,
    location: filters.location,
  });
  return rows.map(toPublicUser);
}

export async function getUserById(id: string): Promise<PublicUser> {
  const user = await findUserById(id);
  if (!user) throw new AppError(404, "User not found");
  return toPublicUser(user);
}

export interface SelfUpdateRequest {
  name?: string;
  location?: string;
}

export async function updateSelf(userId: string, patch: SelfUpdateRequest): Promise<PublicUser> {
  const updated = await updateUser(userId, { name: patch.name, location: patch.location });
  if (!updated) throw new AppError(404, "User not found");
  return toPublicUser(updated);
}

export interface AdminUpdateRequest {
  email?: string;
  name?: string;
  location?: string;
  role?: string;
  employeeId?: string;
  designation?: string;
}

export async function updateUserByAdmin(
  id: string,
  patch: AdminUpdateRequest,
): Promise<PublicUser> {
  if (patch.role !== undefined) assertValidRole(patch.role);

  if (patch.email) {
    const existing = await findUserByEmail(patch.email);
    if (existing && existing.id !== id) {
      throw new AppError(409, "A user with this email already exists");
    }
  }

  const updated = await updateUser(id, {
    email: patch.email,
    name: patch.name,
    location: patch.location,
    role: patch.role as Role | undefined,
    employeeId: patch.employeeId,
    designation: patch.designation,
  });
  if (!updated) throw new AppError(404, "User not found");
  return toPublicUser(updated);
}
