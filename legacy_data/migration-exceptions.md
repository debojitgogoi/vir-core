# Legacy data migration — exceptions report

Generated 2026-09-14T14:07:00.285Z by `scripts/migrate-legacy-data.ts`.
127 row(s) affected by a documented skip/null-and-log rule (see legacy_data/migrated_db_structure/migration-plan.md §3.3).

## duplicate pair, lower legacy ID kept (40)

| Table | Legacy ID | Detail |
|---|---|---|
| Prefix_Master | 23 | (equipment_category 1, prefix_name YMLZ) already migrated from a lower legacy ID — row skipped |
| EquipmentSubView_Damage | 95 | (subview 12, damage code 41) already migrated from a lower legacy ID — row skipped |
| EquipmentSubView_Damage | 144 | (subview 19, damage code 41) already migrated from a lower legacy ID — row skipped |
| EquipmentSubView_Damage | 5828 | (subview 381, damage code 41) already migrated from a lower legacy ID — row skipped |
| EquipmentSubView_Damage | 5877 | (subview 388, damage code 41) already migrated from a lower legacy ID — row skipped |
| EquipmentSubView_Damage | 15891 | (subview 1088, damage code 41) already migrated from a lower legacy ID — row skipped |
| EquipmentSubView_Damage | 15940 | (subview 1095, damage code 41) already migrated from a lower legacy ID — row skipped |
| EquipmentSubView_Damage | 28117 | (subview 2138, damage code 41) already migrated from a lower legacy ID — row skipped |
| EquipmentSubView_Damage | 28166 | (subview 2145, damage code 41) already migrated from a lower legacy ID — row skipped |
| EquipmentSubView_Damage | 33639 | (subview 2491, damage code 41) already migrated from a lower legacy ID — row skipped |
| EquipmentSubView_Damage | 33688 | (subview 2498, damage code 41) already migrated from a lower legacy ID — row skipped |
| EquipmentSubView_Damage | 33840 | (subview 2512, damage code 48) already migrated from a lower legacy ID — row skipped |
| EquipmentMainView_Misc | 7 | (main_view 1, misc item 16) already migrated from a lower legacy ID — row skipped |
| Equipment_Misc | 8 | (main_view 22, component 46) already migrated from a lower legacy ID — row skipped per §1.17 |
| Equipment_Misc | 40 | (main_view 24, component 87) already migrated from a lower legacy ID — row skipped per §1.17 |
| Equipment_Misc | 538 | (main_view 1, component 151) already migrated from a lower legacy ID — row skipped per §1.17 |
| Equipment_Misc | 541 | (main_view 1, component 212) already migrated from a lower legacy ID — row skipped per §1.17 |
| Equipment_Misc | 542 | (main_view 1, component 46) already migrated from a lower legacy ID — row skipped per §1.17 |
| Equipment_Misc | 558 | (main_view 5, component 87) already migrated from a lower legacy ID — row skipped per §1.17 |
| Equipment_Misc | 2288 | (main_view 54, component 46) already migrated from a lower legacy ID — row skipped per §1.17 |
| Equipment_Misc | 2320 | (main_view 56, component 87) already migrated from a lower legacy ID — row skipped per §1.17 |
| Equipment_Misc | 3481 | (main_view 79, component 46) already migrated from a lower legacy ID — row skipped per §1.17 |
| Equipment_Misc | 3513 | (main_view 81, component 87) already migrated from a lower legacy ID — row skipped per §1.17 |
| Equipment_Misc | 4628 | (main_view 102, component 46) already migrated from a lower legacy ID — row skipped per §1.17 |
| Equipment_Misc | 4660 | (main_view 104, component 87) already migrated from a lower legacy ID — row skipped per §1.17 |
| Equipment_Misc | 5162 | (main_view 120, component 21) already migrated from a lower legacy ID — row skipped per §1.17 |
| Equipment_Misc | 5191 | (main_view 120, component 53) already migrated from a lower legacy ID — row skipped per §1.17 |
| Equipment_Misc | 5194 | (main_view 120, component 56) already migrated from a lower legacy ID — row skipped per §1.17 |
| Equipment_Misc | 5203 | (main_view 120, component 65) already migrated from a lower legacy ID — row skipped per §1.17 |
| Equipment_Misc | 5205 | (main_view 120, component 67) already migrated from a lower legacy ID — row skipped per §1.17 |
| Equipment_Misc | 5218 | (main_view 120, component 87) already migrated from a lower legacy ID — row skipped per §1.17 |
| Equipment_Misc | 5224 | (main_view 120, component 95) already migrated from a lower legacy ID — row skipped per §1.17 |
| Equipment_Misc | 5225 | (main_view 120, component 96) already migrated from a lower legacy ID — row skipped per §1.17 |
| Equipment_Misc | 5231 | (main_view 120, component 103) already migrated from a lower legacy ID — row skipped per §1.17 |
| Equipment_Misc | 5246 | (main_view 120, component 122) already migrated from a lower legacy ID — row skipped per §1.17 |
| Equipment_Misc | 5276 | (main_view 120, component 153) already migrated from a lower legacy ID — row skipped per §1.17 |
| Equipment_Misc | 5287 | (main_view 120, component 164) already migrated from a lower legacy ID — row skipped per §1.17 |
| Equipment_Misc | 5302 | (main_view 120, component 189) already migrated from a lower legacy ID — row skipped per §1.17 |
| Equipment_Misc | 5321 | (main_view 120, component 212) already migrated from a lower legacy ID — row skipped per §1.17 |
| Equipment_Misc | 5340 | (main_view 120, component 348) already migrated from a lower legacy ID — row skipped per §1.17 |

## orphaned FK (1)

| Table | Legacy ID | Detail |
|---|---|---|
| EquipmentSubView | 805 | ComponentID_FK 374 does not resolve — component_id set to NULL |

## excluded (misc_item_id NOT NULL) (3)

| Table | Legacy ID | Detail |
|---|---|---|
| EquipmentMainView_Misc | 737 | MiscID_FK 17 does not resolve — row excluded per §1.12 |
| EquipmentMainView_Misc | 738 | MiscID_FK 18 does not resolve — row excluded per §1.12 |
| EquipmentMainView_Misc | 739 | MiscID_FK 19 does not resolve — row excluded per §1.12 |

## unresolvable RepairCode, nulled (83)

| Table | Legacy ID | Detail |
|---|---|---|
| Action_MST | 7 | RepairCode 200 does not resolve to a repair code ID — repair_code_id set to NULL per §1.16 |
| Action_MST | 11 | RepairCode 200 does not resolve to a repair code ID — repair_code_id set to NULL per §1.16 |
| Action_MST | 57 | RepairCode 200 does not resolve to a repair code ID — repair_code_id set to NULL per §1.16 |
| Action_MST | 62 | RepairCode 200 does not resolve to a repair code ID — repair_code_id set to NULL per §1.16 |
| Action_MST | 68 | RepairCode 200 does not resolve to a repair code ID — repair_code_id set to NULL per §1.16 |
| Action_MST | 79 | RepairCode 200 does not resolve to a repair code ID — repair_code_id set to NULL per §1.16 |
| Action_MST | 80 | RepairCode 200 does not resolve to a repair code ID — repair_code_id set to NULL per §1.16 |
| Action_MST | 90 | RepairCode 200 does not resolve to a repair code ID — repair_code_id set to NULL per §1.16 |
| Action_MST | 91 | RepairCode 200 does not resolve to a repair code ID — repair_code_id set to NULL per §1.16 |
| Action_MST | 96 | RepairCode 200 does not resolve to a repair code ID — repair_code_id set to NULL per §1.16 |
| Action_MST | 102 | RepairCode 200 does not resolve to a repair code ID — repair_code_id set to NULL per §1.16 |
| Action_MST | 104 | RepairCode 200 does not resolve to a repair code ID — repair_code_id set to NULL per §1.16 |
| Action_MST | 137 | RepairCode 200 does not resolve to a repair code ID — repair_code_id set to NULL per §1.16 |
| Action_MST | 196 | RepairCode 200 does not resolve to a repair code ID — repair_code_id set to NULL per §1.16 |
| Action_MST | 216 | RepairCode 200 does not resolve to a repair code ID — repair_code_id set to NULL per §1.16 |
| Action_MST | 265 | RepairCode 200 does not resolve to a repair code ID — repair_code_id set to NULL per §1.16 |
| Action_MST | 285 | RepairCode 200 does not resolve to a repair code ID — repair_code_id set to NULL per §1.16 |
| Action_MST | 343 | RepairCode 200 does not resolve to a repair code ID — repair_code_id set to NULL per §1.16 |
| Action_MST | 347 | RepairCode 200 does not resolve to a repair code ID — repair_code_id set to NULL per §1.16 |
| Action_MST | 348 | RepairCode 200 does not resolve to a repair code ID — repair_code_id set to NULL per §1.16 |
| Action_MST | 350 | RepairCode 200 does not resolve to a repair code ID — repair_code_id set to NULL per §1.16 |
| Action_MST | 358 | RepairCode 200 does not resolve to a repair code ID — repair_code_id set to NULL per §1.16 |
| Action_MST | 366 | RepairCode 200 does not resolve to a repair code ID — repair_code_id set to NULL per §1.16 |
| Action_MST | 371 | RepairCode 200 does not resolve to a repair code ID — repair_code_id set to NULL per §1.16 |
| Action_MST | 375 | RepairCode 200 does not resolve to a repair code ID — repair_code_id set to NULL per §1.16 |
| Action_MST | 376 | RepairCode 200 does not resolve to a repair code ID — repair_code_id set to NULL per §1.16 |
| Action_MST | 378 | RepairCode 200 does not resolve to a repair code ID — repair_code_id set to NULL per §1.16 |
| Action_MST | 436 | RepairCode 200 does not resolve to a repair code ID — repair_code_id set to NULL per §1.16 |
| Action_MST | 456 | RepairCode 200 does not resolve to a repair code ID — repair_code_id set to NULL per §1.16 |
| Action_MST | 505 | RepairCode 200 does not resolve to a repair code ID — repair_code_id set to NULL per §1.16 |
| Action_MST | 525 | RepairCode 200 does not resolve to a repair code ID — repair_code_id set to NULL per §1.16 |
| Action_MST | 542 | RepairCode 200 does not resolve to a repair code ID — repair_code_id set to NULL per §1.16 |
| Action_MST | 567 | RepairCode 200 does not resolve to a repair code ID — repair_code_id set to NULL per §1.16 |
| Action_MST | 572 | RepairCode 200 does not resolve to a repair code ID — repair_code_id set to NULL per §1.16 |
| Action_MST | 578 | RepairCode 200 does not resolve to a repair code ID — repair_code_id set to NULL per §1.16 |
| Action_MST | 580 | RepairCode 200 does not resolve to a repair code ID — repair_code_id set to NULL per §1.16 |
| Action_MST | 613 | RepairCode 200 does not resolve to a repair code ID — repair_code_id set to NULL per §1.16 |
| Action_MST | 618 | RepairCode 200 does not resolve to a repair code ID — repair_code_id set to NULL per §1.16 |
| Action_MST | 624 | RepairCode 200 does not resolve to a repair code ID — repair_code_id set to NULL per §1.16 |
| Action_MST | 635 | RepairCode 200 does not resolve to a repair code ID — repair_code_id set to NULL per §1.16 |
| Action_MST | 641 | RepairCode 200 does not resolve to a repair code ID — repair_code_id set to NULL per §1.16 |
| Action_MST | 657 | RepairCode 200 does not resolve to a repair code ID — repair_code_id set to NULL per §1.16 |
| Action_MST | 660 | RepairCode 200 does not resolve to a repair code ID — repair_code_id set to NULL per §1.16 |
| Action_MST | 669 | RepairCode 200 does not resolve to a repair code ID — repair_code_id set to NULL per §1.16 |
| Action_MST | 679 | RepairCode 200 does not resolve to a repair code ID — repair_code_id set to NULL per §1.16 |
| Action_MST | 683 | RepairCode 200 does not resolve to a repair code ID — repair_code_id set to NULL per §1.16 |
| Action_MST | 690 | RepairCode 200 does not resolve to a repair code ID — repair_code_id set to NULL per §1.16 |
| Action_MST | 696 | RepairCode 200 does not resolve to a repair code ID — repair_code_id set to NULL per §1.16 |
| Action_MST | 707 | RepairCode 200 does not resolve to a repair code ID — repair_code_id set to NULL per §1.16 |
| Action_MST | 708 | RepairCode 200 does not resolve to a repair code ID — repair_code_id set to NULL per §1.16 |
| Action_MST | 718 | RepairCode 200 does not resolve to a repair code ID — repair_code_id set to NULL per §1.16 |
| Action_MST | 719 | RepairCode 200 does not resolve to a repair code ID — repair_code_id set to NULL per §1.16 |
| Action_MST | 724 | RepairCode 200 does not resolve to a repair code ID — repair_code_id set to NULL per §1.16 |
| Action_MST | 730 | RepairCode 200 does not resolve to a repair code ID — repair_code_id set to NULL per §1.16 |
| Action_MST | 732 | RepairCode 200 does not resolve to a repair code ID — repair_code_id set to NULL per §1.16 |
| Action_MST | 758 | RepairCode 200 does not resolve to a repair code ID — repair_code_id set to NULL per §1.16 |
| Action_MST | 762 | RepairCode 200 does not resolve to a repair code ID — repair_code_id set to NULL per §1.16 |
| Action_MST | 763 | RepairCode 200 does not resolve to a repair code ID — repair_code_id set to NULL per §1.16 |
| Action_MST | 765 | RepairCode 200 does not resolve to a repair code ID — repair_code_id set to NULL per §1.16 |
| Action_MST | 773 | RepairCode 200 does not resolve to a repair code ID — repair_code_id set to NULL per §1.16 |
| Action_MST | 781 | RepairCode 200 does not resolve to a repair code ID — repair_code_id set to NULL per §1.16 |
| Action_MST | 786 | RepairCode 200 does not resolve to a repair code ID — repair_code_id set to NULL per §1.16 |
| Action_MST | 790 | RepairCode 200 does not resolve to a repair code ID — repair_code_id set to NULL per §1.16 |
| Action_MST | 791 | RepairCode 200 does not resolve to a repair code ID — repair_code_id set to NULL per §1.16 |
| Action_MST | 793 | RepairCode 200 does not resolve to a repair code ID — repair_code_id set to NULL per §1.16 |
| Action_MST | 863 | RepairCode 200 does not resolve to a repair code ID — repair_code_id set to NULL per §1.16 |
| Action_MST | 869 | RepairCode 200 does not resolve to a repair code ID — repair_code_id set to NULL per §1.16 |
| Action_MST | 894 | RepairCode 200 does not resolve to a repair code ID — repair_code_id set to NULL per §1.16 |
| Action_MST | 899 | RepairCode 200 does not resolve to a repair code ID — repair_code_id set to NULL per §1.16 |
| Action_MST | 905 | RepairCode 200 does not resolve to a repair code ID — repair_code_id set to NULL per §1.16 |
| Action_MST | 907 | RepairCode 200 does not resolve to a repair code ID — repair_code_id set to NULL per §1.16 |
| Action_MST | 923 | RepairCode 200 does not resolve to a repair code ID — repair_code_id set to NULL per §1.16 |
| Action_MST | 929 | RepairCode 200 does not resolve to a repair code ID — repair_code_id set to NULL per §1.16 |
| Action_MST | 940 | RepairCode 200 does not resolve to a repair code ID — repair_code_id set to NULL per §1.16 |
| Action_MST | 946 | RepairCode 200 does not resolve to a repair code ID — repair_code_id set to NULL per §1.16 |
| Action_MST | 962 | RepairCode 200 does not resolve to a repair code ID — repair_code_id set to NULL per §1.16 |
| Action_MST | 965 | RepairCode 200 does not resolve to a repair code ID — repair_code_id set to NULL per §1.16 |
| Action_MST | 974 | RepairCode 200 does not resolve to a repair code ID — repair_code_id set to NULL per §1.16 |
| Action_MST | 980 | RepairCode 200 does not resolve to a repair code ID — repair_code_id set to NULL per §1.16 |
| Action_MST | 1043 | RepairCode 200 does not resolve to a repair code ID — repair_code_id set to NULL per §1.16 |
| Action_MST | 1063 | RepairCode 200 does not resolve to a repair code ID — repair_code_id set to NULL per §1.16 |
| Action_MST | 1083 | RepairCode 200 does not resolve to a repair code ID — repair_code_id set to NULL per §1.16 |
| Action_MST | 1103 | RepairCode 200 does not resolve to a repair code ID — repair_code_id set to NULL per §1.16 |
