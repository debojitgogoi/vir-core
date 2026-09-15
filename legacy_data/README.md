# vir.sqlite — Database Schema

`vir.sqlite` is a **read-only** legacy SQLite database (looks like an Android/mobile app local DB — note the
`android_metadata` table) used as a source to extract data from. It models an equipment inspection / damage-estimation /
gate-in-gate-out workflow (container/chassis equipment, damage & repair catalogs, estimator/surveyor workflow,
gatekeeper check-in, driver, account/lease details).

This document lists every table, its columns/types, and its current row count, to serve as a reference while extracting
data.

## Table of contents

| Table                                                             |   Rows | Purpose (inferred)                                               |
|-------------------------------------------------------------------|-------:|------------------------------------------------------------------|
| [EquipmentType](#equipmenttype)                                   |      2 | Top-level equipment type catalog (e.g. container, chassis)       |
| [EquipmentSubType](#equipmentsubtype)                             |      7 | Sub-types under an `EquipmentType`                               |
| [EquipmentMainView](#equipmentmainview)                           |    121 | Main diagram/view per equipment sub-type (for damage mapping UI) |
| [EquipmentSubView](#equipmentsubview)                             |  2,820 | Sub-view/zoom regions within a main view                         |
| [EquipmentSubView_Damage](#equipmentsubview_damage)               | 38,551 | Damage codes applicable to a sub-view                            |
| [EquipmentSubView_Repair](#equipmentsubview_repair)               | 22,557 | Repair codes applicable to a sub-view                            |
| [EquipmentSubView_ExtraBoxItem](#equipmentsubview_extraboxitem)   |    432 | Extra input fields/boxes attached to a sub-view                  |
| [EquipmentSubView_TriggeredItem](#equipmentsubview_triggereditem) |     18 | UI components/actions triggered from a sub-view                  |
| [EquipmentMainView_Misc](#equipmentmainview_misc)                 |    853 | Misc items linked to a main view                                 |
| [Equipment_Misc](#equipment_misc)                                 |  5,357 | Misc components mapped to equipment (component/sub-view)         |
| [Equipment_Misc1](#equipment_misc1)                               |  4,620 | Duplicate/variant of `Equipment_Misc`                            |
| [EquipmentLocCopy](#equipmentloccopy)                             |  2,246 | Denormalized copy of equipment location hierarchy                |
| [Component_Master](#component_master)                             |    362 | Component catalog (code, description, cost)                      |
| [Damage_MST](#damage_mst)                                         |     98 | Damage code catalog                                              |
| [Repairs_MST](#repairs_mst)                                       |     86 | Repair code catalog                                              |
| [Action_MST](#action_mst)                                         |  1,133 | Action catalog (component+repair combinations, time/material)    |
| [Action_MST1](#action_mst1)                                       |  1,133 | Duplicate/variant of `Action_MST`                                |
| [Misc_Master](#misc_master)                                       |    139 | Misc item catalog per equipment type                             |
| [Prefix_Master](#prefix_master)                                   |     30 | Unit-number prefix catalog per equipment sub-type                |
| [UIComponent_Master](#uicomponent_master)                         |      5 | UI component/widget type catalog                                 |
| [UIBox_Details](#uibox_details)                                   |  1,486 | Value options for an `EquipmentSubView_ExtraBoxItem`             |
| [GateKeeperMode_Master](#gatekeepermode_master)                   |      4 | Gatekeeper mode catalog (e.g. in/out)                            |
| [Role_Master](#role_master)                                       |      3 | User role catalog                                                |
| [GateKeeperDetails](#gatekeeperdetails)                           |      0 | Gate check-in/out records                                        |
| [Driver_Master](#driver_master)                                   |      0 | Driver records                                                   |
| [AccountDetails](#accountdetails)                                 |      0 | Account/lease/manufacturer details for equipment                 |
| [EstimatorDetails](#estimatordetails)                             |      0 | Estimator/surveyor job header records                            |
| [EstimatorSurvey](#estimatorsurvey)                               |      0 | Estimator/surveyor line-item survey records                      |
| [ExtraFieldEstimatorSurvey](#extrafieldestimatorsurvey)           |      0 | Extra field values captured during a survey                      |
| [ActionDetails](#actiondetails)                                   |      0 | Actions (approve/reject) recorded per estimator detail           |
| [ActionImageDetails](#actionimagedetails)                         |      0 | Images attached to an action                                     |
| [EquipmentEstimateImages](#equipmentestimateimages)               |      0 | Images attached to an estimate                                   |
| [Login_Master](#login_master)                                     |      0 | Saved login/server connection profiles                           |
| [Login_Properties](#login_properties)                             |      0 | Role assigned to a login                                         |
| [android_metadata](#android_metadata)                             |      1 | Standard Android SQLite locale metadata table                    |

**Populated (reference/catalog) tables:** EquipmentType, EquipmentSubType, EquipmentMainView, EquipmentSubView,
EquipmentSubView_Damage, EquipmentSubView_Repair, EquipmentSubView_ExtraBoxItem, EquipmentSubView_TriggeredItem,
EquipmentMainView_Misc, Equipment_Misc, Equipment_Misc1, EquipmentLocCopy, Component_Master, Damage_MST, Repairs_MST,
Action_MST, Action_MST1, Misc_Master, Prefix_Master, UIComponent_Master, UIBox_Details, GateKeeperMode_Master,
Role_Master, android_metadata.

**Empty tables (0 rows):** GateKeeperDetails, Driver_Master, AccountDetails, EstimatorDetails, EstimatorSurvey,
ExtraFieldEstimatorSurvey, ActionDetails, ActionImageDetails, EquipmentEstimateImages, Login_Master, Login_Properties.
These are transactional/session tables — empty in this snapshot because it's a template/clean local DB (no device usage
data captured).

---

## Table definitions

### EquipmentType

Rows: 2

| Column        | Type     | Notes                     |
|---------------|----------|---------------------------|
| ID            | INTEGER  | PK                        |
| EquipmentType | TEXT     |                           |
| ImagePath     | TEXT     |                           |
| Datetime      | DATETIME | default CURRENT_TIMESTAMP |
| IsDisabled    | INTEGER  |                           |

### EquipmentSubType

Rows: 7

| Column               | Type     | Notes                     |
|----------------------|----------|---------------------------|
| ID                   | INTEGER  | PK                        |
| EquipmentTypeID_FK   | INTEGER  | FK → EquipmentType.ID     |
| EquipmentSubTypeName | TEXT     |                           |
| ImageName            | TEXT     |                           |
| ImagePath            | TEXT     |                           |
| ThumbImagePath       | TEXT     |                           |
| EquipmentSubTypeDesc | TEXT     |                           |
| Datetime             | DATETIME | default CURRENT_TIMESTAMP |
| IsDisabled           | INTEGER  |                           |
| ImageFolderPath      | TEXT     |                           |

### EquipmentMainView

Rows: 121

| Column                | Type     | Notes                     |
|-----------------------|----------|---------------------------|
| ID                    | INTEGER  | PK                        |
| EquipmentSubTypeID_FK | INTEGER  | FK → EquipmentSubType.ID  |
| Name                  | TEXT     |                           |
| BubbleName            | TEXT     |                           |
| LabelName             | TEXT     |                           |
| SequenceNumber        | INTEGER  |                           |
| ImageFolderPath       | TEXT     |                           |
| Bubble_X1             | INTEGER  |                           |
| Bubble_Y1             | INTEGER  |                           |
| Datetime              | DATETIME | default CURRENT_TIMESTAMP |
| IsDisabled            | INTEGER  |                           |
| BubbleImagePath       | TEXT     |                           |
| RedImagePath          | TEXT     |                           |

### EquipmentSubView

Rows: 2,820

| Column                 | Type     | Notes                              |
|------------------------|----------|------------------------------------|
| ID                     | INTEGER  | PK                                 |
| EquipmentMainViewID_FK | INTEGER  | FK → EquipmentMainView.ID          |
| ComponentID_FK         | INTEGER  | FK → Component_Master.ID           |
| Name                   | TEXT     |                                    |
| Header                 | TEXT     |                                    |
| HasChild               | INTEGER  |                                    |
| SubViewDesc            | TEXT     |                                    |
| ParentID               | INTEGER  | self-referencing (parent sub-view) |
| ImageFolderPath        | TEXT     |                                    |
| HotspotPath            | TEXT     |                                    |
| RedImagePath           | TEXT     |                                    |
| BubbleImagePath        | TEXT     |                                    |
| Hostspot_X1            | INTEGER  | (sic — typo in source column name) |
| Hotspot_Y1             | INTEGER  |                                    |
| Bubble_X1              | INTEGER  |                                    |
| Bubble_Y1              | INTEGER  |                                    |
| Datetime               | DATETIME | default CURRENT_TIMESTAMP          |
| IsDisabled             | INTEGER  |                                    |
| showMiscItemsOfParent  | INTEGER  | default 1                          |
| ExtraBoxItem           | INTEGER  |                                    |
| TriggerEvents          | INTEGER  |                                    |
| Location               | TEXT     |                                    |

### EquipmentSubView_Damage

Rows: 38,551

| Column                | Type     | Notes                     |
|-----------------------|----------|---------------------------|
| ID                    | INTEGER  | PK                        |
| DamageID_FK           | INTEGER  | FK → Damage_MST.ID        |
| EquipmentSubViewID_FK | INTEGER  | FK → EquipmentSubView.ID  |
| Datetime              | DATETIME | default CURRENT_TIMESTAMP |

### EquipmentSubView_Repair

Rows: 22,557

| Column                | Type     | Notes                     |
|-----------------------|----------|---------------------------|
| Datetime              | DATETIME | default CURRENT_TIMESTAMP |
| EquipmentSubViewID_FK | INTEGER  | FK → EquipmentSubView.ID  |
| ID                    | INTEGER  | PK                        |
| RepairID_FK           | INTEGER  | FK → Repairs_MST.ID       |

### EquipmentSubView_ExtraBoxItem

Rows: 432

| Column                | Type     | Notes                      |
|-----------------------|----------|----------------------------|
| ID                    | INTEGER  | PK                         |
| EquipmentSubViewID_FK | INTEGER  | FK → EquipmentSubView.ID   |
| Label                 | TEXT     |                            |
| UIComponent_Master_FK | INTEGER  | FK → UIComponent_Master.ID |
| Datetime              | DATETIME | default CURRENT_TIMESTAMP  |
| Key                   | TEXT     |                            |
| Sequence              | INTEGER  |                            |
| Position              | TEXT     |                            |

### EquipmentSubView_TriggeredItem

Rows: 18

| Column                | Type     | Notes                      |
|-----------------------|----------|----------------------------|
| ID                    | INTEGER  | PK                         |
| EquipmentSubViewID_FK | INTEGER  | FK → EquipmentSubView.ID   |
| Label                 | TEXT     |                            |
| UIComponent_Master_FK | INTEGER  | FK → UIComponent_Master.ID |
| Datetime              | DATETIME | default CURRENT_TIMESTAMP  |
| CallNext              | INTEGER  |                            |
| Sequence              | INTEGER  |                            |
| MethodName            | TEXT     |                            |

### EquipmentMainView_Misc

Rows: 853

| Column                 | Type     | Notes                     |
|------------------------|----------|---------------------------|
| ID                     | INTEGER  | PK                        |
| EquipmentMainViewID_FK | INTEGER  | FK → EquipmentMainView.ID |
| MiscID_FK              | INTEGER  | FK → Misc_Master.ID       |
| Datetime               | DATETIME | default CURRENT_TIMESTAMP |

### Equipment_Misc

Rows: 5,357

| Column                 | Type     | Notes                                        |
|------------------------|----------|----------------------------------------------|
| ID                     | INTEGER  | PK                                           |
| EquipmentMainViewID_FK | INTEGER  | default 0; FK → EquipmentMainView.ID         |
| ComponentID_FK         | INTEGER  | FK → Component_Master.ID                     |
| Datetime               | DATETIME | default CURRENT_TIMESTAMP                    |
| EquipmentSubViewId_FK  | INTEGER  | NOT NULL default 0; FK → EquipmentSubView.ID |
| IsWithParent           | INTEGER  | NOT NULL default 0                           |

### Equipment_Misc1

Rows: 4,620

Same structure as `Equipment_Misc` (appears to be a duplicate/legacy variant table).

| Column                 | Type     | Notes                     |
|------------------------|----------|---------------------------|
| ID                     | INTEGER  | PK                        |
| EquipmentMainViewID_FK | INTEGER  | default 0                 |
| ComponentID_FK         | INTEGER  |                           |
| Datetime               | DATETIME | default CURRENT_TIMESTAMP |
| EquipmentSubViewId_FK  | INTEGER  | NOT NULL default 0        |
| IsWithParent           | INTEGER  | NOT NULL default 0        |

### EquipmentLocCopy

Rows: 2,246

Denormalized/flattened copy combining equipment type/sub-type/main-view/component hierarchy with location.

| Column            | Type    | Notes                    |
|-------------------|---------|--------------------------|
| ID                | INTEGER | PK                       |
| EquipmentType     | INTEGER |                          |
| EquipmentSubType  | INTEGER |                          |
| EquipmentMainView | INTEGER |                          |
| ComponentID_FK    | INTEGER | FK → Component_Master.ID |
| Name              | TEXT    |                          |
| HasChild          | INTEGER |                          |
| ParentID          | INTEGER |                          |
| ImageFolderPath   | TEXT    |                          |
| Location          | TEXT    |                          |

### Component_Master

Rows: 362

| Column        | Type     | Notes                     |
|---------------|----------|---------------------------|
| ID            | INTEGER  | PK                        |
| ComponentDesc | TEXT     |                           |
| ComponentCode | TEXT     |                           |
| ComponentCost | TEXT     |                           |
| Datetime      | DATETIME | default CURRENT_TIMESTAMP |

### Damage_MST

Rows: 98

| Column     | Type     | Notes                     |
|------------|----------|---------------------------|
| ID         | INTEGER  | PK                        |
| DamageCode | TEXT     |                           |
| DamageDesc | TEXT     |                           |
| Datetime   | DATETIME | default CURRENT_TIMESTAMP |

### Repairs_MST

Rows: 86

| Column     | Type     | Notes                     |
|------------|----------|---------------------------|
| ID         | INTEGER  | PK                        |
| RepairCode | TEXT     |                           |
| RepairDesc | TEXT     |                           |
| RepairTime | TEXT     |                           |
| Datetime   | DATETIME | default CURRENT_TIMESTAMP |

### Action_MST

Rows: 1,133

| Column        | Type    | Notes                                     |
|---------------|---------|-------------------------------------------|
| ID            | INTEGER | PK                                        |
| MainViewID_FK | INTEGER | FK → EquipmentMainView.ID                 |
| Action        | TEXT    |                                           |
| ComponentCode | TEXT    | references Component_Master.ComponentCode |
| RepairCode    | TEXT    | references Repairs_MST.RepairCode         |
| Time          | TEXT    |                                           |
| Material      | TEXT    |                                           |
| IsSubView     | TEXT    |                                           |

### Action_MST1

Rows: 1,133

Same structure as `Action_MST` (duplicate/legacy variant table).

| Column        | Type    | Notes |
|---------------|---------|-------|
| ID            | INTEGER | PK    |
| MainViewID_FK | INTEGER |       |
| Action        | TEXT    |       |
| ComponentCode | TEXT    |       |
| RepairCode    | TEXT    |       |
| Time          | TEXT    |       |
| Material      | TEXT    |       |
| IsSubView     | TEXT    |       |

### Misc_Master

Rows: 139

| Column             | Type     | Notes                     |
|--------------------|----------|---------------------------|
| ID                 | INTEGER  | PK                        |
| Misc_Name          | TEXT     |                           |
| Misc_Code          | TEXT     |                           |
| EquipmentTypeID_FK | INTEGER  | FK → EquipmentType.ID     |
| Datetime           | DATETIME | default CURRENT_TIMESTAMP |

### Prefix_Master

Rows: 30

| Column                | Type     | Notes                     |
|-----------------------|----------|---------------------------|
| ID                    | INTEGER  | PK                        |
| EquipmentSubTypeID_FK | INTEGER  | FK → EquipmentSubType.ID  |
| Prefix_Name           | TEXT     |                           |
| Datetime              | DATETIME | default CURRENT_TIMESTAMP |

### UIComponent_Master

Rows: 5

| Column   | Type     | Notes                       |
|----------|----------|-----------------------------|
| ID       | INTEGER  | PK                          |
| Name     | TEXT     | e.g. widget/input type name |
| Datetime | DATETIME | default CURRENT_TIMESTAMP   |

### UIBox_Details

Rows: 1,486

| Column                             | Type     | Notes                                 |
|------------------------------------|----------|---------------------------------------|
| EquipmentSubView_ExtraBoxItemID_FK | INTEGER  | FK → EquipmentSubView_ExtraBoxItem.ID |
| LabelValue                         | TEXT     | option value/label                    |
| ID                                 | INTEGER  | PK                                    |
| Datetime                           | DATETIME | default CURRENT_TIMESTAMP             |

### GateKeeperMode_Master

Rows: 4

| Column          | Type     | Notes                     |
|-----------------|----------|---------------------------|
| ID              | INTEGER  | PK                        |
| GateKeeper_Mode | TEXT     | e.g. Gate In / Gate Out   |
| Datetime        | DATETIME | default CURRENT_TIMESTAMP |

### Role_Master

Rows: 3

| Column   | Type     | Notes                     |
|----------|----------|---------------------------|
| ID       | INTEGER  | PK                        |
| RoleName | TEXT     |                           |
| Datetime | DATETIME | default CURRENT_TIMESTAMP |

### GateKeeperDetails

Rows: 0

| Column                | Type     | Notes                         |
|-----------------------|----------|-------------------------------|
| GateKeeperDetails_ID  | INTEGER  | PK                            |
| GateKeeper_ID         | INTEGER  |                               |
| Prefix_MasterID_FK    | INTEGER  | FK → Prefix_Master.ID         |
| UnitNumber            | TEXT     |                               |
| EquipmentTypeID_FK    | INTEGER  | FK → EquipmentType.ID         |
| EquipmentSubTypeID_FK | INTEGER  | FK → EquipmentSubType.ID      |
| EquipmentPhoto_Path   | TEXT     |                               |
| IsUploaded            | INTEGER  |                               |
| UploadedDateTime      | TEXT     |                               |
| Server_JobID          | INTEGER  | default -1                    |
| Status                | TEXT     |                               |
| OutBoundSignPath      | TEXT     |                               |
| OutBoundImgPath       | TEXT     |                               |
| OutBoundDate          | DATETIME |                               |
| Review                | TEXT     |                               |
| Driver_Master_FK      | INTEGER  | FK → Driver_Master.ID         |
| GateKeeperModeID_FK   | INTEGER  | FK → GateKeeperMode_Master.ID |
| CurrentDate           | DATETIME | default CURRENT_TIMESTAMP     |
| AccountDetailsID_FK   | INTEGER  | FK → AccountDetails.ID        |
| FHWA                  | TEXT     |                               |
| ChassisLICPlate       | TEXT     |                               |
| TruckerCode           | TEXT     |                               |
| InspectorSign         | TEXT     |                               |

### Driver_Master

Rows: 0

| Column                | Type     | Notes                     |
|-----------------------|----------|---------------------------|
| Driver_Server_ID      | INTEGER  | default -1                |
| Driver_Name           | TEXT     |                           |
| DriverSign            | TEXT     |                           |
| DriverLicenseImgePath | TEXT     |                           |
| Barcode               | TEXT     |                           |
| CurrentDate           | DATETIME | default CURRENT_TIMESTAMP |
| ID                    | INTEGER  | PK                        |

### AccountDetails

Rows: 0

| Column                  | Type    | Notes |
|-------------------------|---------|-------|
| ID                      | INTEGER | PK    |
| AccountID               | INTEGER |       |
| AccountName             | TEXT    |       |
| Lessee                  | TEXT    |       |
| BookingRedeliveryNumber | TEXT    |       |
| SurveyorName            | TEXT    |       |
| ManufacturerName        | TEXT    |       |
| State                   | TEXT    |       |
| DppInsureCoverageNumber | TEXT    |       |
| LeaseMonth              | INTEGER |       |
| LicPlate                | TEXT    |       |
| TractorPlate            | TEXT    |       |
| ManufacturerMonth       | INTEGER |       |
| ManufacturerYear        | INTEGER |       |
| HireMonth               | INTEGER |       |
| HireYear                | INTEGER |       |
| ExpMonth                | INTEGER |       |
| ExpYear                 | INTEGER |       |
| TurnInMonth             | INTEGER |       |
| TurnInYear              | INTEGER |       |
| CscMonth                | INTEGER |       |
| CscYear                 | INTEGER |       |
| CargoGrade              | TEXT    |       |
| WindGrade               | TEXT    |       |
| GeneralCondition        | TEXT    |       |

### EstimatorDetails

Rows: 0

| Column                  | Type     | Notes                                       |
|-------------------------|----------|---------------------------------------------|
| EstimatorDetails_ID     | INTEGER  | PK                                          |
| GateKeeperDetails_ID_FK | INTEGER  | FK → GateKeeperDetails.GateKeeperDetails_ID |
| GateKeeper_ID           | INTEGER  |                                             |
| Estimator_ID            | INTEGER  |                                             |
| Prefix_MasterID_FK      | INTEGER  | FK → Prefix_Master.ID                       |
| UnitNumber              | TEXT     |                                             |
| EquipmentTypeID_FK      | INTEGER  | FK → EquipmentType.ID                       |
| EquipmentSubTypeID_FK   | INTEGER  | FK → EquipmentSubType.ID                    |
| Server_JobID            | INTEGER  |                                             |
| SeqOrNormal             | INTEGER  | default 0                                   |
| isEstimator             | INTEGER  |                                             |
| isSurveyor              | INTEGER  |                                             |
| UploadedDateTime        | TEXT     |                                             |
| Datetime                | DATETIME | default CURRENT_TIMESTAMP                   |
| EstimatorStatus         | TEXT     | default `Start`                             |
| LastPlayedSeq           | INTEGER  | default -1                                  |
| IsWorking               | INTEGER  | default -1                                  |
| IsSurveyorEdit          | INTEGER  |                                             |
| IsSurveyorDelete        | INTEGER  |                                             |

### EstimatorSurvey

Rows: 0

| Column                 | Type     | Notes                                     |
|------------------------|----------|-------------------------------------------|
| EstimatorDetails_ID_FK | INTEGER  | FK → EstimatorDetails.EstimatorDetails_ID |
| EquipmentSubViewID_FK  | INTEGER  | FK → EquipmentSubView.ID                  |
| Surveyor_ID            | INTEGER  |                                           |
| Hours                  | INTEGER  |                                           |
| Quantity               | INTEGER  |                                           |
| ImagePath              | TEXT     |                                           |
| Comment                | TEXT     |                                           |
| DamageID_FK            | INTEGER  | FK → Damage_MST.ID                        |
| RepairID_FK            | INTEGER  | FK → Repairs_MST.ID                       |
| ComponentID_FK         | INTEGER  | FK → Component_Master.ID                  |
| ReponsibleParty        | TEXT     | (sic — typo in source column name)        |
| Server_ID              | INTEGER  |                                           |
| DimensionWidth         | INTEGER  |                                           |
| DimensionHeight        | INTEGER  |                                           |
| CheckAndAdvice         | TEXT     |                                           |
| IsUploaded             | INTEGER  |                                           |
| Desc                   | TEXT     |                                           |
| ApproveOrReject        | INTEGER  | default -1                                |
| Datetime               | DATETIME | default CURRENT_TIMESTAMP                 |
| EstimatorSurvey_ID     | INTEGER  | PK                                        |
| LabourHours            | TEXT     |                                           |
| LabourCost             | TEXT     |                                           |
| PartsCost              | TEXT     |                                           |
| Total                  | TEXT     |                                           |
| Type                   | CHAR     |                                           |
| IsSurveyorEdit         | INTEGER  | default 0                                 |
| IsSurveyorDelete       | INTEGER  | default 0                                 |

### ExtraFieldEstimatorSurvey

Rows: 0

| Column                             | Type     | Notes                                   |
|------------------------------------|----------|-----------------------------------------|
| ID                                 | INTEGER  | PK                                      |
| EstimatorSurveyID_FK               | INTEGER  | FK → EstimatorSurvey.EstimatorSurvey_ID |
| EquipmentSubView_ExtraBoxItemID_FK | INTEGER  | FK → EquipmentSubView_ExtraBoxItem.ID   |
| UIBox_Values                       | TEXT     |                                         |
| Datetime                           | DATETIME | default CURRENT_TIMESTAMP               |
| ServerID                           | INTEGER  |                                         |

### ActionDetails

Rows: 0

| Column                 | Type    | Notes                                     |
|------------------------|---------|-------------------------------------------|
| ID                     | INTEGER | PK                                        |
| ActionMSTID_FK         | INTEGER | FK → Action_MST.ID                        |
| EstimatorDetails_ID_FK | INTEGER | FK → EstimatorDetails.EstimatorDetails_ID |
| ActionServer_ID        | INTEGER |                                           |
| IsEstimator            | INTEGER | default 0                                 |
| IsSurveyor             | INTEGER | default 0                                 |
| ApproveOrReject        | INTEGER | default -1                                |
| ActionComment          | TEXT    |                                           |

### ActionImageDetails

Rows: 0

| Column                | Type    | Notes                                     |
|-----------------------|---------|-------------------------------------------|
| ID                    | INTEGER | PK                                        |
| EstimatorDetailsID_FK | INTEGER | FK → EstimatorDetails.EstimatorDetails_ID |
| ActionDetailsID_FK    | INTEGER | FK → ActionDetails.ID                     |
| ImagePath             | TEXT    |                                           |

### EquipmentEstimateImages

Rows: 0

| Column         | Type     | Notes                     |
|----------------|----------|---------------------------|
| ID             | INTEGER  | PK                        |
| EstimateID     | INTEGER  |                           |
| ImagePath      | VARCHAR  |                           |
| Datetime       | DATETIME | default CURRENT_TIMESTAMP |
| IsType         | INTEGER  |                           |
| EstimationType | CHAR     |                           |

### Login_Master

Rows: 0

| Column    | Type     | Notes                     |
|-----------|----------|---------------------------|
| ID        | INTEGER  | PK                        |
| Server_ID | INTEGER  |                           |
| UserName  | TEXT     |                           |
| Password  | TEXT     |                           |
| DbName    | TEXT     |                           |
| Path      | TEXT     |                           |
| isDefault | INTEGER  |                           |
| Datetime  | DATETIME | default CURRENT_TIMESTAMP |

### Login_Properties

Rows: 0

| Column            | Type     | Notes                     |
|-------------------|----------|---------------------------|
| ID                | INTEGER  |                           |
| Login_MasterID_FK | INTEGER  | FK → Login_Master.ID      |
| Role_MasterID_FK  | INTEGER  | FK → Role_Master.ID       |
| Datetime          | DATETIME | default CURRENT_TIMESTAMP |

### android_metadata

Rows: 1

| Column | Type | Notes                                  |
|--------|------|----------------------------------------|
| locale | TEXT | standard Android SQLite metadata table |

---

## Relationship overview (inferred from `_FK` column naming)

```
EquipmentType ─┬─ EquipmentSubType ─┬─ EquipmentMainView ─┬─ EquipmentSubView ──┬── EquipmentSubView_Damage ── Damage_MST
               │                    │                     │                     ├── EquipmentSubView_Repair ── Repairs_MST
               │                    │                     │                     ├── EquipmentSubView_ExtraBoxItem ── UIBox_Details
               │                    │                     │                     │                              └── UIComponent_Master
               │                    │                     │                     └── EquipmentSubView_TriggeredItem ── UIComponent_Master
               │                    │                     └── EquipmentMainView_Misc ── Misc_Master
               │                    └── Prefix_Master
               └── Misc_Master

Equipment_Misc / Equipment_Misc1 ── EquipmentMainView, EquipmentSubView, Component_Master
EquipmentLocCopy ── EquipmentType, EquipmentSubType, EquipmentMainView, Component_Master
Action_MST / Action_MST1 ── EquipmentMainView (via MainViewID_FK), Component_Master/Repairs_MST (via code, not FK id)

GateKeeperDetails ── Prefix_Master, EquipmentType, EquipmentSubType, Driver_Master, GateKeeperMode_Master, AccountDetails
EstimatorDetails ── GateKeeperDetails, Prefix_Master, EquipmentType, EquipmentSubType
EstimatorSurvey ── EstimatorDetails, EquipmentSubView, Damage_MST, Repairs_MST, Component_Master
ExtraFieldEstimatorSurvey ── EstimatorSurvey, EquipmentSubView_ExtraBoxItem
ActionDetails ── Action_MST, EstimatorDetails
ActionImageDetails ── EstimatorDetails, ActionDetails
Login_Properties ── Login_Master, Role_Master
```

## Notes

- No explicit `FOREIGN KEY` constraints are declared in the schema — all relationships above are inferred from `_FK`
  -suffixed column names and naming conventions, and should be validated against actual data before relying on them for
  joins.
- `Action_MST1` and `Equipment_Misc1` appear to be near-duplicates of `Action_MST` and `Equipment_Misc` respectively
  (same schema, similar row counts) — check both when extracting data, and confirm with the source app which one is
  authoritative.
- Tables with 0 rows (transactional/session data: gatekeeper, estimator/survey, login, actions, images) are empty in
  this snapshot; only reference/catalog tables are populated.
