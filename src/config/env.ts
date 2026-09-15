import dotenv from "dotenv";

dotenv.config();

function required(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

const jwtSecret = process.env.JWT_SECRET ?? "change-me";

/**
 * Signature receipt keys, by version. A receipt stores the version it was
 * signed with, so rotating is additive: set SIGNATURE_SECRET_V2, restart, and
 * every receipt written under version 1 still verifies against the key it was
 * written with. Nothing is ever re-signed.
 *
 * Takes its environment rather than reading process.env so it stays a pure
 * mapping — and so its tests cannot be fooled by whatever the developer's
 * .env happens to contain, given dotenv.config() runs when this module loads.
 */
export function resolveSignatureKeys(
  source: NodeJS.ProcessEnv,
  fallbackSecret: string,
  isProduction: boolean,
): Record<number, string> {
  const keys: Record<number, string> = {};

  // Version 1 is the unsuffixed variable, so a deployment that never rotates
  // never has to think about version numbers at all.
  if (isProduction && !source.SIGNATURE_SECRET) {
    throw new Error(
      "Missing required environment variable: SIGNATURE_SECRET. " +
        "Signature receipts must not share JWT_SECRET in production: one stolen " +
        "value would forge both access tokens and customer acknowledgments.",
    );
  }
  // Outside production this falls back so the app and the test suite run
  // unconfigured, the same convenience glbUrlSecret and mediaUrlSecret take.
  // Production does not get it: a receipt is what a customer's acknowledgment
  // rests on, and that is worth one required variable.
  keys[1] = source.SIGNATURE_SECRET || fallbackSecret;

  for (const [name, value] of Object.entries(source)) {
    const match = /^SIGNATURE_SECRET_V(\d+)$/.exec(name);
    if (!match || !value) continue;
    const version = Number(match[1]);
    // Version 1 is spelled SIGNATURE_SECRET. Honouring a second spelling would
    // create two sources of truth for one version, and whichever lost would
    // fail silently — every receipt written under it unverifiable.
    if (version >= 2) keys[version] = value;
  }

  return keys;
}

/** The version new receipts are signed with. Always one that has a key. */
export function resolveSignatureKeyVersion(
  keys: Record<number, string>,
  source: NodeJS.ProcessEnv,
): number {
  const versions = Object.keys(keys).map(Number);
  const pinned = source.SIGNATURE_KEY_VERSION;
  if (pinned === undefined || pinned === "") return Math.max(...versions);

  const version = Number(pinned);
  if (!Number.isInteger(version) || !versions.includes(version)) {
    throw new Error(
      `SIGNATURE_KEY_VERSION=${pinned} has no key configured; ` +
        `available versions: ${versions.sort((a, b) => a - b).join(", ")}`,
    );
  }
  return version;
}

const signatureKeys = resolveSignatureKeys(
  process.env,
  jwtSecret,
  (process.env.NODE_ENV ?? "development") === "production",
);

export const env = {
  port: Number(process.env.PORT ?? 3000),
  nodeEnv: process.env.NODE_ENV ?? "development",
  databaseUrl: required("DATABASE_URL"),
  jwtSecret,

  // GLB asset storage. storageRoot is resolved against the process cwd when
  // relative, so `./storage` means the project directory in dev.
  storageRoot: process.env.STORAGE_ROOT ?? "./storage",
  glbMaxBytes: Number(process.env.GLB_MAX_BYTES ?? 100 * 1024 * 1024),
  glbUrlTtlSeconds: Number(process.env.GLB_URL_TTL_SECONDS ?? 900),
  // Signing key for download URLs. Separate from JWT_SECRET so asset URLs can
  // be rotated without invalidating every access token, but falls back to it
  // so nothing extra is required to run the app.
  glbUrlSecret: process.env.GLB_URL_SECRET ?? jwtSecret,

  // Photographs, not 3D models: a far smaller cap than glbMaxBytes.
  mediaMaxBytes: Number(process.env.MEDIA_MAX_BYTES ?? 15 * 1024 * 1024),
  mediaUrlTtlSeconds: Number(process.env.MEDIA_URL_TTL_SECONDS ?? 900),
  // Separate from glbUrlSecret so media URLs and model URLs can be rotated
  // independently. The two fall back to the same value, which is why the token
  // type is carried in a `typ` claim rather than implied by the key.
  mediaUrlSecret: process.env.MEDIA_URL_SECRET ?? process.env.GLB_URL_SECRET ?? jwtSecret,

  // Every key this build can verify a receipt with, and the one it signs new
  // receipts with. See resolveSignatureKeys above for the rotation contract.
  signatureKeys: Object.freeze(signatureKeys) as Readonly<Record<number, string>>,
  signatureKeyVersion: resolveSignatureKeyVersion(signatureKeys, process.env),
};
