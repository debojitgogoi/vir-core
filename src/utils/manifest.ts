/**
 * GLB manifest extraction and validation.
 *
 * The manifest is a JSON description of the 3-tier Blender hierarchy baked into
 * a GLB (main_view -> sub_view -> leaf). It is the bridge between the GLB's
 * objects and the equipment-type data: each node carries the `slug_id` of the
 * main_view/subview it maps to. `extractManifestFromGlb` builds it from the
 * GLB's own node graph; `validateManifest` then checks it.
 *
 * This module is deliberately pure — manifest in, violations out. No database,
 * no filesystem, no Express. Validation is *structural only*: slug_ids are
 * checked for format and uniqueness, but never looked up against main_views or
 * subviews, so a model may legitimately be ahead of the equipment data.
 *
 * Unknown keys — both top-level and per-node — are preserved untouched by
 * validation, so render hints (bounding boxes, pivots, camera framing) can be
 * added later without changing the validator.
 */

import { isValidSlugId } from "./slug-id";

export const NODE_TYPES = ["main_view", "sub_view", "leaf"] as const;
export type ManifestNodeType = (typeof NODE_TYPES)[number];

export interface ManifestNode {
  node_name: string;
  slug_id: string | null;
  node_type: ManifestNodeType;
  is_leaf: boolean;
  display_name: string;
  parent: string | null;
  children: string[];
  // Passthrough render hints and anything else the extractor emits.
  [key: string]: unknown;
}

export interface Manifest {
  manifest_version: string;
  roots: string[];
  nodes: Record<string, ManifestNode>;
  index: { by_slug_id: Record<string, string>; [key: string]: unknown };
  [key: string]: unknown;
}

export interface ManifestValidationResult {
  manifest: Manifest;
  nodeCount: number;
}

export class ManifestValidationError extends Error {
  violations: string[];

  constructor(violations: string[]) {
    super("Manifest failed validation");
    this.violations = violations;
  }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((v) => typeof v === "string");
}

/**
 * Validate a parsed manifest and return it with a server-derived `index`.
 *
 * The caller's `index.by_slug_id` is ignored and rebuilt from `nodes`, so a
 * stale or hand-edited index can never disagree with the hierarchy.
 *
 * @throws ManifestValidationError with every violation found, not just the first.
 */
export function validateManifest(input: unknown): ManifestValidationResult {
  const violations: string[] = [];

  if (!isPlainObject(input)) {
    throw new ManifestValidationError(["manifest must be a JSON object"]);
  }

  const manifestVersion = input.manifest_version;
  if (typeof manifestVersion !== "string" || manifestVersion.trim() === "") {
    violations.push("manifest_version must be a non-empty string");
  }

  if (!isPlainObject(input.nodes)) {
    // Nothing below can run without a nodes map, so bail out here rather than
    // report a cascade of confusing follow-on errors.
    violations.push("nodes must be an object keyed by node name");
    throw new ManifestValidationError(violations);
  }

  const rawNodes = input.nodes;
  const nodeNames = Object.keys(rawNodes);
  if (nodeNames.length === 0) {
    violations.push("nodes must contain at least one node");
    throw new ManifestValidationError(violations);
  }

  // Pass 1: per-node shape. Only nodes that survive this pass take part in the
  // reference/traversal checks below, so a malformed node yields one clear
  // error instead of polluting every later check.
  const nodes: Record<string, ManifestNode> = {};
  for (const key of nodeNames) {
    const raw = rawNodes[key];
    if (!isPlainObject(raw)) {
      violations.push(`nodes["${key}"] must be an object`);
      continue;
    }

    let ok = true;
    const fail = (message: string): void => {
      violations.push(`nodes["${key}"]: ${message}`);
      ok = false;
    };

    if (raw.node_name !== key) {
      fail(`node_name must equal its key (got ${JSON.stringify(raw.node_name)})`);
    }
    if (!NODE_TYPES.includes(raw.node_type as ManifestNodeType)) {
      fail(`node_type must be one of ${NODE_TYPES.join(" | ")} (got ${JSON.stringify(raw.node_type)})`);
    }
    if (typeof raw.is_leaf !== "boolean") {
      fail("is_leaf must be a boolean");
    }
    if (typeof raw.display_name !== "string") {
      fail("display_name must be a string");
    }
    if (raw.parent !== null && typeof raw.parent !== "string") {
      fail("parent must be a node name or null");
    }
    if (!isStringArray(raw.children)) {
      fail("children must be an array of node names");
    }

    const slugId = raw.slug_id;
    if (slugId !== null && slugId !== undefined && typeof slugId !== "string") {
      fail("slug_id must be a string or null");
    } else if (typeof slugId === "string" && slugId !== "" && !isValidSlugId(slugId)) {
      fail(`slug_id "${slugId}" is not a valid slug (8 characters, 0-9 A-Z)`);
    }

    if (ok) {
      const node = raw as unknown as ManifestNode;
      // Normalize an absent slug to null so consumers have one empty case.
      node.slug_id = typeof slugId === "string" && slugId !== "" ? slugId : null;
      nodes[key] = node;
    }
  }

  if (Object.keys(nodes).length === 0) {
    throw new ManifestValidationError(violations);
  }

  // Pass 2: cross-node consistency.
  for (const [name, node] of Object.entries(nodes)) {
    if (node.is_leaf !== (node.children.length === 0)) {
      violations.push(
        `nodes["${name}"]: is_leaf is ${node.is_leaf} but the node has ${node.children.length} children`,
      );
    }
    if (node.node_type === "leaf" && !node.is_leaf) {
      violations.push(`nodes["${name}"]: node_type "leaf" requires is_leaf true`);
    }
    if (node.node_type === "main_view" && node.parent !== null) {
      violations.push(`nodes["${name}"]: main_view nodes must be top-level (parent must be null)`);
    }
    if (node.node_type !== "main_view" && node.parent === null) {
      violations.push(`nodes["${name}"]: only main_view nodes may have a null parent`);
    }

    if (node.parent !== null && !(node.parent in nodes)) {
      violations.push(`nodes["${name}"]: parent "${node.parent}" does not exist`);
    } else if (node.parent !== null && !nodes[node.parent].children.includes(name)) {
      violations.push(
        `nodes["${name}"]: parent "${node.parent}" does not list it as a child`,
      );
    }

    for (const child of node.children) {
      if (!(child in nodes)) {
        violations.push(`nodes["${name}"]: child "${child}" does not exist`);
      } else if (nodes[child].parent !== name) {
        violations.push(`nodes["${name}"]: child "${child}" does not point back to it as parent`);
      }
    }
  }

  // Pass 3: slug uniqueness. by_slug_id maps a slug to a single node, so a
  // duplicate would silently drop one part from the index and leave it dead in
  // the 3D view. Reject it here, where a modeller can still fix it.
  const nodeNamesBySlug = new Map<string, string[]>();
  for (const [name, node] of Object.entries(nodes)) {
    if (node.slug_id === null) continue;
    const existing = nodeNamesBySlug.get(node.slug_id);
    if (existing) existing.push(name);
    else nodeNamesBySlug.set(node.slug_id, [name]);
  }
  for (const [slugId, names] of nodeNamesBySlug) {
    if (names.length > 1) {
      violations.push(`slug_id "${slugId}" is used by more than one node: ${names.join(", ")}`);
    }
  }

  // Pass 4: roots must be exactly the parentless nodes, and walking from them
  // must reach every node exactly once — which rules out cycles and detached
  // subtrees in a single traversal.
  const derivedRoots = Object.entries(nodes)
    .filter(([, node]) => node.parent === null)
    .map(([name]) => name)
    .sort();

  if (!isStringArray(input.roots)) {
    violations.push("roots must be an array of node names");
  } else {
    const declared = [...input.roots].sort();
    if (declared.length !== derivedRoots.length || declared.some((n, i) => n !== derivedRoots[i])) {
      violations.push(
        `roots must list exactly the top-level nodes (expected ${JSON.stringify(derivedRoots)}, got ${JSON.stringify(declared)})`,
      );
    }
  }

  const visited = new Set<string>();
  const stack = [...derivedRoots];
  while (stack.length > 0) {
    const name = stack.pop() as string;
    if (visited.has(name)) {
      violations.push(`nodes["${name}"] is reachable from more than one parent`);
      continue;
    }
    visited.add(name);
    for (const child of nodes[name].children) {
      if (child in nodes) stack.push(child);
    }
  }
  for (const name of Object.keys(nodes)) {
    if (!visited.has(name)) {
      violations.push(`nodes["${name}"] is not reachable from any root (cycle or detached subtree)`);
    }
  }

  if (violations.length > 0) {
    throw new ManifestValidationError(violations);
  }

  // Rebuild the index from the validated hierarchy rather than trusting the
  // uploaded one.
  const bySlugId: Record<string, string> = {};
  for (const [slugId, names] of nodeNamesBySlug) {
    bySlugId[slugId] = names[0];
  }

  const incomingIndex = isPlainObject(input.index) ? input.index : {};
  const manifest: Manifest = {
    ...(input as Record<string, unknown>),
    manifest_version: manifestVersion as string,
    roots: derivedRoots,
    nodes,
    index: { ...incomingIndex, by_slug_id: bySlugId },
  };

  return { manifest, nodeCount: Object.keys(nodes).length };
}

/**
 * Check that a buffer is a glTF binary container.
 *
 * A GLB starts with a 12-byte header: the magic "glTF", a uint32 version, and
 * a uint32 total length. Checking it here means a mis-picked .blend or .gltf
 * is rejected at upload rather than failing inside a client's loader.
 */
export function isGlbBuffer(buffer: Buffer): boolean {
  if (buffer.length < 12) return false;
  if (buffer.toString("ascii", 0, 4) !== "glTF") return false;
  return buffer.readUInt32LE(4) === 2;
}

// GLB extraction ------------------------------------------------------------

const GLB_CHUNK_TYPE_JSON = 0x4e4f534a;
const MANIFEST_VERSION = "1.0";

/** Blender name prefix -> node_type, used when a node carries no extras. */
const PREFIX_NODE_TYPES: Array<[string, ManifestNodeType]> = [
  ["MV_", "main_view"],
  ["SV_", "sub_view"],
  ["LF_", "leaf"],
];

interface GltfNode {
  name?: string;
  children?: number[];
  extras?: Record<string, unknown>;
}

/**
 * Read the JSON chunk out of a GLB.
 *
 * A GLB is a 12-byte header followed by length-prefixed chunks, the first of
 * which must be JSON. Only that chunk is needed here — the binary chunk holds
 * geometry, which the manifest does not describe — so no glTF library is
 * required.
 */
function readGlbJsonChunk(buffer: Buffer): Record<string, unknown> {
  if (!isGlbBuffer(buffer)) {
    throw new ManifestValidationError(["file is not a glTF binary (.glb) v2 file"]);
  }

  let offset = 12;
  while (offset + 8 <= buffer.length) {
    const chunkLength = buffer.readUInt32LE(offset);
    const chunkType = buffer.readUInt32LE(offset + 4);
    const dataStart = offset + 8;
    const dataEnd = dataStart + chunkLength;

    if (dataEnd > buffer.length) {
      throw new ManifestValidationError(["GLB is truncated: a chunk runs past the end of the file"]);
    }

    if (chunkType === GLB_CHUNK_TYPE_JSON) {
      try {
        const parsed: unknown = JSON.parse(buffer.toString("utf8", dataStart, dataEnd));
        if (!isPlainObject(parsed)) {
          throw new Error("not an object");
        }
        return parsed;
      } catch {
        throw new ManifestValidationError(["GLB JSON chunk is not a valid glTF document"]);
      }
    }

    // Chunks are 4-byte aligned.
    offset = dataEnd + ((4 - (chunkLength % 4)) % 4);
  }

  throw new ManifestValidationError(["GLB contains no JSON chunk"]);
}

function nodeTypeOf(node: GltfNode): ManifestNodeType | null {
  const declared = node.extras?.node_type;
  if (typeof declared === "string") {
    const match = NODE_TYPES.find((t) => t === declared);
    if (match) return match;
  }
  // No usable extras — fall back to the Blender naming convention.
  const name = node.name;
  if (typeof name === "string") {
    for (const [prefix, nodeType] of PREFIX_NODE_TYPES) {
      if (name.startsWith(prefix)) return nodeType;
    }
  }
  return null;
}

/**
 * Build a manifest from a GLB's own node graph.
 *
 * Nodes are included when they carry a usable `node_type` in their glTF
 * `extras` or their name uses an MV_/SV_/LF_ prefix; everything else (cameras,
 * lights, helper empties, untagged geometry) is skipped. A skipped node does
 * not break the hierarchy — an included node is re-parented to its nearest
 * included ancestor, so an untagged empty sitting between a sub-view and its
 * meshes is simply passed through.
 *
 * `is_leaf` is computed from the resulting children rather than read from
 * extras: after skipping, the extras value can easily disagree with the
 * hierarchy that actually ends up in the manifest.
 *
 * The result is deliberately returned unvalidated — callers pass it through
 * validateManifest so that extracted and hand-authored manifests are held to
 * exactly the same rules and produce the same error messages.
 */
export function extractManifestFromGlb(
  buffer: Buffer,
  sourceFilename: string,
): Record<string, unknown> {
  const gltf = readGlbJsonChunk(buffer);
  const rawNodes = Array.isArray(gltf.nodes) ? (gltf.nodes as GltfNode[]) : [];

  const violations: string[] = [];

  // Pass 1: decide which glTF nodes take part, and map each index to its name.
  const includedTypes = new Map<number, ManifestNodeType>();
  const nameByIndex = new Map<number, string>();
  const seenNames = new Map<string, number>();

  rawNodes.forEach((node, index) => {
    const nodeType = nodeTypeOf(node);
    if (nodeType === null) return;

    const name = typeof node.name === "string" ? node.name : "";
    if (name === "") {
      violations.push(
        `glTF node at index ${index} is tagged as ${nodeType} but has no name, so it cannot be addressed`,
      );
      return;
    }

    const previous = seenNames.get(name);
    if (previous !== undefined) {
      violations.push(
        `duplicate node name "${name}" (glTF node indexes ${previous} and ${index}) — node names must be unique`,
      );
      return;
    }

    seenNames.set(name, index);
    includedTypes.set(index, nodeType);
    nameByIndex.set(index, name);
  });

  if (violations.length > 0) throw new ManifestValidationError(violations);
  if (includedTypes.size === 0) {
    throw new ManifestValidationError([
      "GLB contains no MV_/SV_/LF_ nodes and no nodes tagged with a node_type — nothing to build a manifest from",
    ]);
  }

  // Pass 2: invert the glTF child lists into a parent lookup over every node,
  // included or not, so skipped nodes can be walked through.
  const parentOfIndex = new Map<number, number>();
  rawNodes.forEach((node, index) => {
    for (const child of node.children ?? []) {
      if (typeof child === "number" && child >= 0 && child < rawNodes.length) {
        parentOfIndex.set(child, index);
      }
    }
  });

  /** Nearest ancestor that made it into the manifest, or null. */
  function includedAncestorOf(index: number): number | null {
    const seen = new Set<number>([index]);
    let current = parentOfIndex.get(index);
    while (current !== undefined && !seen.has(current)) {
      if (includedTypes.has(current)) return current;
      seen.add(current);
      current = parentOfIndex.get(current);
    }
    return null;
  }

  // Pass 3: emit manifest nodes. Children are collected from the resolved
  // parent links rather than the raw glTF lists, which is what makes skipping
  // an intermediate node transparent.
  const nodes: Record<string, Record<string, unknown>> = {};
  const childNamesByIndex = new Map<number, string[]>();
  const parentNameByIndex = new Map<number, string | null>();

  for (const index of includedTypes.keys()) {
    const ancestor = includedAncestorOf(index);
    const name = nameByIndex.get(index) as string;
    parentNameByIndex.set(index, ancestor === null ? null : (nameByIndex.get(ancestor) as string));
    if (ancestor !== null) {
      const siblings = childNamesByIndex.get(ancestor) ?? [];
      siblings.push(name);
      childNamesByIndex.set(ancestor, siblings);
    }
  }

  const roots: string[] = [];
  for (const [index, nodeType] of includedTypes) {
    const name = nameByIndex.get(index) as string;
    const extras = rawNodes[index].extras ?? {};
    const children = childNamesByIndex.get(index) ?? [];
    const parent = parentNameByIndex.get(index) ?? null;

    const slugId = extras.slug_id;
    const displayName = extras.display_name;

    nodes[name] = {
      node_name: name,
      slug_id: typeof slugId === "string" && slugId !== "" ? slugId : null,
      node_type: nodeType,
      is_leaf: children.length === 0,
      display_name:
        typeof displayName === "string" && displayName !== "" ? displayName : name,
      parent,
      children,
    };

    if (parent === null) roots.push(name);
  }

  return {
    manifest_version: MANIFEST_VERSION,
    generator: "vir-backend-extract",
    source_file: sourceFilename,
    generated_at: new Date().toISOString(),
    roots,
    nodes,
    index: { by_slug_id: {} },
  };
}
