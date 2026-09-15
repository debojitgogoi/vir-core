export const ROLES = ["SUPERUSER", "MECHANIC", "ESTIMATOR", "ADMIN"] as const;

export type Role = (typeof ROLES)[number];

export interface MaintenanceDto {
  active?: boolean | null;
  message?: string | null;
  until?: string | null;
}

export interface AppConfigDto {
  force_update_required?: boolean | null;
  minimum_app_version?: string | null;
  latest_app_version?: string | null;
  store_url?: string | null;
  clear_local_cache?: boolean | null;
  cache_epoch?: number | null;
  catalog_version?: string | null;
  maintenance?: MaintenanceDto | null;
}

export interface EquipmentPrefixDto {
  id: string;
  prefix_name: string;
}

export interface EquipmentTypeSummaryDto {
  id: string;
  slug_id: string;
  name: string;
}

export interface EquipmentCategoryDto {
  id: string;
  slug_id: string;
  name: string;
  is_disabled: boolean;
  prefixes: EquipmentPrefixDto[];
  equipment_types: EquipmentTypeSummaryDto[];
}

// Bare-row detail DTO for the standalone by-slug lookup, as opposed to
// EquipmentCategoryDto above which is the richer shape used in the list.
export interface EquipmentCategoryDetailDto {
  id: string;
  slug_id: string;
  name: string;
  is_disabled: boolean;
}

// Lookup entries referenced by id from tree nodes below, instead of being
// embedded (and duplicated) at every node that uses them.
export interface DamageCodeLookupDto {
  damage_code: string;
  damage_description: string | null;
}

export interface RepairCodeLookupDto {
  repair_code: string;
  repair_description: string | null;
}

export interface WidgetTypeLookupDto {
  name: string;
}

export interface QuickActionDto {
  id: string;
  action_name: string;
  repair_code_id: string | null;
  component_id: string | null;
}

export interface FieldOptionDto {
  id: string;
  label_value: string;
  display_order: number;
}

export interface ExtraFieldDto {
  id: string;
  label: string;
  field_name: string;
  display_order: number;
  widget_type_id: string;
  options: FieldOptionDto[];
}

export interface EquipmentSubviewNodeDto {
  id: string;
  slug_id: string;
  name: string;
  header: string | null;
  component_id: string | null;
  children: EquipmentSubviewNodeDto[];
  damage_code_ids: string[];
  repair_code_ids: string[];
  quick_actions: QuickActionDto[];
  fields: ExtraFieldDto[];
}

export interface EquipmentMainViewDto {
  id: string;
  slug_id: string;
  name: string;
  bubble_name: string | null;
  label_name: string | null;
  sequence_number: number | null;
  quick_actions: QuickActionDto[];
  children: EquipmentSubviewNodeDto[];
}

export interface EquipmentTypeDetailsDto {
  id: string;
  slug_id: string;
  equipment_category_id: string;
  name: string;
  is_disabled: boolean;
  damage_codes: Record<string, DamageCodeLookupDto>;
  repair_codes: Record<string, RepairCodeLookupDto>;
  widget_types: Record<string, WidgetTypeLookupDto>;
  main_views: EquipmentMainViewDto[];
}

// 3D GLB model + manifest ---------------------------------------------------

export interface GlbAssetDto {
  original_filename: string;
  content_type: string;
  size_bytes: number;
  checksum_sha256: string;
}

/** The GLB asset plus a short-lived URL for downloading it. */
export interface GlbAssetWithUrlDto extends GlbAssetDto {
  download_url: string;
  expires_at: string;
}

export interface EquipmentTypeModelSummaryDto {
  id: string;
  slug_id: string;
  equipment_type_id: string;
  version_number: number;
  is_active: boolean;
  manifest_version: string;
  node_count: number;
  glb: GlbAssetDto;
  uploaded_by: string | null;
  created_at: string;
}

export interface EquipmentTypeModelDetailsDto {
  id: string;
  slug_id: string;
  equipment_type_id: string;
  equipment_type_slug_id: string;
  version_number: number;
  is_active: boolean;
  manifest_version: string;
  node_count: number;
  manifest: unknown;
  glb: GlbAssetWithUrlDto;
  created_at: string;
  updated_at: string;
}

// Depots and depot membership ---------------------------------------------------

export interface DepotDto {
  id: string;
  slug_id: string;
  code: string;
  name: string;
  timezone: string;
  address: string | null;
  is_disabled: boolean;
}

export interface DepotMemberDto {
  user_id: string;
  name: string | null;
  email: string;
  role: Role;
  assigned_at: string;
}

// Named object rather than flat fields, so a `cursor` can be added later
// without breaking any client that reads `pagination.total`.
export interface PaginationDto {
  limit: number;
  offset: number;
  total: number;
  has_more: boolean;
}

export interface Paginated<T> {
  data: T[];
  pagination: PaginationDto;
}

export const JOB_CARD_STATUSES = [
  "DRAFT",
  "IN_INSPECTION",
  "SUBMITTED",
  "IN_ESTIMATION",
  "ESTIMATED",
  "REPORTED",
  "VOID",
] as const;

export type JobCardStatus = (typeof JOB_CARD_STATUSES)[number];

// Media -------------------------------------------------------------------------

export const MEDIA_CONTENT_TYPES = ["image/jpeg", "image/png", "image/webp"] as const;
export type MediaContentType = (typeof MEDIA_CONTENT_TYPES)[number];

export const MEDIA_STATUSES = ["PENDING", "READY"] as const;
export type MediaStatus = (typeof MEDIA_STATUSES)[number];

export const JOB_CARD_MEDIA_KINDS = ["DRIVER_LICENSE", "CHASSIS"] as const;
export type JobCardMediaKind = (typeof JOB_CARD_MEDIA_KINDS)[number];

/**
 * `storage_key` is deliberately absent: where the bytes live is
 * mediaStorage.ts's business and no client's.
 */
export interface MediaAssetDto {
  id: string;
  status: MediaStatus;
  content_type: MediaContentType;
  size_bytes: number;
  checksum_sha256: string;
  original_filename: string | null;
  /** Present only on assets listed as attachments to something. */
  kind?: JobCardMediaKind;
  uploaded_by: string | null;
  created_at: string;
}

export const JOB_CARD_DIRECTIONS = ["INBOUND", "OUTBOUND"] as const;
export type JobCardDirection = (typeof JOB_CARD_DIRECTIONS)[number];

export const GENSET_STATUSES = [
  "N/A",
  "ATTACHED",
  "POWERED_RUNNING",
  "UNDER_MOUNT",
] as const;
export type GensetStatus = (typeof GENSET_STATUSES)[number];

export const EQUIPMENT_FORMS = [
  "GOOSENECK",
  "TRI_AXLE",
  "STANDARD",
  "SLIDER",
  "REEFER",
] as const;
export type EquipmentForm = (typeof EQUIPMENT_FORMS)[number];

export const REGISTRATION_STATUSES = ["OK", "MISS", "EXPIRED"] as const;
export type RegistrationStatus = (typeof REGISTRATION_STATUSES)[number];

export const EQUIPMENT_SIZES = [20, 40, 45, 53] as const;
export type EquipmentSize = (typeof EQUIPMENT_SIZES)[number];

export interface JobCardDto {
  id: string;
  job_number: string;
  depot_id: string;
  status: JobCardStatus;
  client_uuid: string | null;

  direction: JobCardDirection;
  equipment_type_id: string;
  trucker_name: string | null;
  location: string | null;
  inspected_at: string | null;
  equipment_prefix_id: string | null;
  prefix_text: string | null;
  container_number: string | null;
  chassis_number: string | null;
  genset_status: GensetStatus | null;
  size: EquipmentSize | null;
  equipment_form: EquipmentForm | null;
  serial_number: string | null;
  license_plate: string | null;
  license_state: string | null;
  license_expiry_date: string | null;
  registration_status: RegistrationStatus | null;
  pool_point: string | null;
  customer_name: string | null;
  redelivery_release_no: string | null;
  customer_account_no: string | null;
  on_hire_date: string | null;
  scac_code: string | null;
  fhwa_sticker_date: string | null;
  driver_name: string | null;
  manufacture_year: number | null;

  created_by: string | null;
  updated_by: string | null;
  submitted_by: string | null;
  submitted_at: string | null;
  locked_at: string | null;
  /** Computed per caller from locked_at, not stored. */
  can_edit: boolean;
  created_at: string;
  updated_at: string;
}

/**
 * Who put their name to the acknowledgment. Mirrors the CHECK on
 * job_card_signatures.signer_role.
 */
export const SIGNER_ROLES = ["CUSTOMER", "DRIVER", "TRUCKER"] as const;
export type SignerRole = (typeof SIGNER_ROLES)[number];

export interface SignatureDto {
  id: string;
  job_card_id: string;
  signer_name: string;
  signer_role: SignerRole;
  signed_at: string;
  payload_hash: string;
  key_version: number;
  payload_version: number;
  device_id: string | null;
  created_by: string | null;
  created_at: string;
}

/**
 * Why a receipt does not verify.
 *
 * NO_SIGNATURE          — nothing has been signed for this card.
 * CONTENT_MODIFIED      — an acknowledged field changed after signing. Ordinary;
 *                         the fix is to re-sign the card.
 * RECEIPT_TAMPERED      — the content still matches but the stored HMAC does
 *                         not, so the signatures table itself was edited. Not
 *                         ordinary: do NOT re-sign, this is an incident.
 * RECEIPT_UNVERIFIABLE  — the receipt names a signing key or payload version
 *                         this build no longer holds, so the server can judge
 *                         it neither way.
 */
export const SIGNATURE_INVALID_REASONS = [
  "NO_SIGNATURE",
  "CONTENT_MODIFIED",
  "RECEIPT_TAMPERED",
  "RECEIPT_UNVERIFIABLE",
] as const;
export type SignatureInvalidReason = (typeof SIGNATURE_INVALID_REASONS)[number];

export type SignatureVerification =
  | {
      valid: true;
      signed_at: string;
      signer_name: string;
      signer_role: SignerRole;
      key_version: number;
      payload_version: number;
    }
  | { valid: false; reason: SignatureInvalidReason };

/**
 * One inspection line item as the API returns it.
 *
 * Damage and repair codes are id lists rather than embedded objects: the
 * client already holds the code tables from `GET /equipment-types/:id`, and
 * embedding them would repeat the same descriptions on every item of every
 * card. `custom_fields` is the stored snapshot taken at write time, not the
 * live field definitions — a field renamed since does not rewrite what this
 * card recorded.
 */
export interface InspectionItemCustomField {
  subview_field_id: string;
  field_name: string;
  label: string;
  widget: string;
  value: unknown;
  option_id: string | null;
}

export interface InspectionItemDto {
  id: string;
  job_card_id: string;
  main_view_id: string | null;
  subview_id: string | null;
  component_id: string | null;
  condition_rating: string | null;
  notes: string | null;
  custom_fields: InspectionItemCustomField[];
  display_order: number;
  client_uuid: string | null;
  damage_code_ids: string[];
  repair_code_ids: string[];
  created_by: string | null;
  created_at: string;
  updated_at: string;
}

/**
 * One status transition, as the audit trail returns it.
 *
 * `from_status` is null when there was no prior status. `job_card_id` is
 * omitted: the route that serves these already names the card in its path, and
 * repeating it on every row of a list says nothing.
 */
export interface JobCardEventDto {
  id: string;
  from_status: JobCardStatus | null;
  to_status: JobCardStatus;
  actor_user_id: string | null;
  note: string | null;
  created_at: string;
}
