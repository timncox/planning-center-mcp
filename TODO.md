# TODO

## Goal
- [ ] Ship a reliable read-only Planning Center MCP for weekly church ops intelligence.

## Milestone 1 — Foundation
- [x] Migrate package management to pnpm only
- [x] Add `PCO_BASE_URL` for mocked tests
- [x] Add typecheck/build/test scripts
- [x] Ensure startup/errors/debug logs use stderr, not stdout
- [x] Add Playwright MCP stdio smoke tests

## Milestone 2 — Core Loop
- [x] Fix Services endpoint shapes requiring `serviceTypeId`
- [x] Add robust 429/transient HTTP backoff
- [x] Add `pco_weekend_readiness`
- [x] Add `pco_guest_followup`
- [x] Add `pco_ministry_health_summary`
- [x] Add `pco_connection_status` for onboarding/module diagnostics
- [x] Add chart-ready `pco_dashboard_snapshot`
- [x] Add service review memory: `pco_service_review_packet` + `pco_record_service_feedback`
- [x] Add `pco_capabilities_guide` and onboarding prompt for capability discovery

## Milestone 3 — QA + Release
- [x] Add Playwright coverage target: 90% where MCP/browser-visible behavior exists
- [x] Implement first 3 core-loop Playwright tests
- [x] Run validation commands
- [x] Expand mocked PCO fixture coverage across Services, Check-Ins, Giving, Groups
- [x] Add easy user install guide
- [x] Prepare npm package bin metadata for `npx` / `pnpm dlx`
- [x] Document release notes

## Open Risks
- [ ] PCO endpoint/API permission variance — mitigate with fixtures and clear errors
- [ ] Generic wrapper positioning — mitigate with workflow-first tools
- [ ] Rate limits — mitigate with backoff and metadata
- [ ] No UI/browser surface yet — Playwright currently validates MCP stdio protocol, not browser flows

## Milestone 4 — Write tools expansion

Shipped 2026-05-22 (21 tool pairs across People / Services / Groups / Calendar). Built end-to-end via 4 parallel agents in isolated worktrees, then aggregated.

Decision (2026-05-22): every new write tool MUST follow the existing Services pattern — `preview_*` → `apply_*` → entry in `mcp_audit_logs` → support `pco_rollback_*`. No raw write tools that skip preview.

### Phase 0 — Foundation
- [x] Document the existing Services preview-token + apply + audit + rollback pattern (`src/tools/services.ts`, `src/tools/workflows.ts`) so contributors can extend it consistently
- [x] Decide where preview tokens are stored — in-memory Map per phase module (15-min TTL); `auditOperations` lives 7 days (mirrors `src/tools/services.ts`)

### Phase 1 — People writes (highest daily-use value)
- [x] `pco_preview_add_note` / `pco_apply_add_note` — append a note to a person (category + text)
- [x] `pco_preview_update_person_field` / `pco_apply_update_person_field` — typed enum of safe attributes (nickname, phone, address, etc.)
- [x] `pco_preview_add_to_list` / `pco_apply_add_to_list` — saved-segment membership
- [x] `pco_preview_remove_from_list` / `pco_apply_remove_from_list`
- [x] `pco_preview_create_workflow_card` / `pco_apply_create_workflow_card` — triggers PCO notifications to assignee; preview must show recipient
- [x] `pco_preview_update_household_membership` / `pco_apply_update_household_membership`

### Phase 2 — Services writes (extend paul's existing work)
- [x] `pco_preview_add_song_to_plan` / `pco_apply_add_song_to_plan` — insert at position N
- [x] `pco_preview_reorder_plan_items` / `pco_apply_reorder_plan_items`
- [x] `pco_preview_set_item_key_or_tempo` / `pco_apply_set_item_key_or_tempo`
- [x] `pco_preview_schedule_position` / `pco_apply_schedule_position` — sends volunteer notification; preview must show emails
- [x] `pco_preview_confirm_or_decline_position` / `pco_apply_confirm_or_decline_position`
- [x] `pco_preview_create_plan` / `pco_apply_create_plan`

### Phase 3 — Groups writes
- [x] `pco_preview_add_to_group` / `pco_apply_add_to_group`
- [x] `pco_preview_remove_from_group` / `pco_apply_remove_from_group`
- [x] `pco_preview_log_group_attendance` / `pco_apply_log_group_attendance`
- [x] `pco_preview_send_group_email` / `pco_apply_send_group_email` — preview must show recipient list + body
- [x] `pco_preview_create_group_meeting` / `pco_apply_create_group_meeting`

### Phase 4 — Calendar writes
- [x] `pco_preview_create_calendar_event` / `pco_apply_create_calendar_event`
- [x] `pco_preview_update_event_time` / `pco_apply_update_event_time`
- [x] `pco_preview_approve_resource_request` / `pco_apply_approve_resource_request`

### Deliberately NOT in scope for v1
- Giving: refunds, statement generation, recurring setup — financial; defer to admin UI
- Check-Ins: anything touching pickup authorization — child-safety sensitive
- Registrations: refund_registration — money movement
- People: create_person — too easy to fat-finger duplicates without dedup logic first
