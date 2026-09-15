/**
 * Slug ID utility for generating URL-friendly unique identifiers.
 *
 * slug_id is an 8-character uppercase alphanumeric string (charset: 0-9, A-Z),
 * generated via nanoid's `customAlphabet`, used for URL-safe identification.
 */

// nanoid ships ESM-only (its package.json has no "require" export condition).
// This project compiles to CommonJS, and TypeScript downlevels a plain
// `import("nanoid")` under `module: commonjs` into `require("nanoid")`
// wrapped in a Promise — which still throws ERR_REQUIRE_ESM on Node versions
// that don't support require(esm) (< 22.12). Routing the import through
// `Function` hides it from that downlevel so it stays a real, native dynamic
// import at runtime, which works on every Node version this project targets.
type NanoidModule = typeof import("nanoid");
const importNanoid = new Function(
  "return import('nanoid')",
) as () => Promise<NanoidModule>;

const CHARSET = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ";
const SLUG_ID_LENGTH = 8;

let generatorPromise: Promise<() => string> | null = null;

function getGenerator(): Promise<() => string> {
  generatorPromise ??= importNanoid().then(({ customAlphabet }) =>
    customAlphabet(CHARSET, SLUG_ID_LENGTH),
  );
  return generatorPromise;
}

/**
 * Generate a random 8-character slug_id using uppercase alphanumeric characters.
 *
 * @returns An 8-character string from the charset [0-9A-Z]
 *
 * @example
 * const id = await generateSlugId();
 * // Returns something like: "A7K2M9PQ"
 */
export async function generateSlugId(): Promise<string> {
  const generate = await getGenerator();
  return generate();
}

/**
 * Generate multiple unique slug_ids.
 *
 * @param count - Number of slug_ids to generate
 * @returns Array of unique slug_ids
 *
 * @example
 * const ids = await generateMultipleSlugIds(5);
 * // Returns: ["A7K2M9PQ", "B4X1L6YZ", ...]
 */
export async function generateMultipleSlugIds(count: number): Promise<string[]> {
  const generate = await getGenerator();
  const generated = new Set<string>();
  const maxAttempts = count * 100; // Prevent infinite loops

  let attempts = 0;
  while (generated.size < count && attempts < maxAttempts) {
    generated.add(generate());
    attempts++;
  }

  if (generated.size < count) {
    throw new Error(
      `Failed to generate ${count} unique slug_ids after ${maxAttempts} attempts`,
    );
  }

  return Array.from(generated);
}

/**
 * Validate that a string is a valid slug_id format.
 *
 * @param value - String to validate
 * @returns true if the string is exactly 8 characters from the charset [0-9A-Z]
 *
 * @example
 * isValidSlugId('A7K2M9PQ'); // true
 * isValidSlugId('a7k2m9pq'); // false (lowercase not allowed)
 * isValidSlugId('A7K2M9PQ!'); // false (invalid character)
 * isValidSlugId('A7K2'); // false (too short)
 */
export function isValidSlugId(value: string): boolean {
  if (!value || typeof value !== "string" || value.length !== SLUG_ID_LENGTH) {
    return false;
  }

  for (const char of value) {
    if (!CHARSET.includes(char)) {
      return false;
    }
  }

  return true;
}
