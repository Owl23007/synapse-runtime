---
id: feature-id
status: wip
lang: en

translations:
  zh-CN: ./template.cn.md

links:
  issues: []
  discussions: []
  rfcs: []
  docs: []
  implementations: []
---

# [Feature Name]

> One sentence describing the problem this feature solves and the capability it provides.

## Summary

Explain in 3-5 sentences:

- What problem currently exists
- What this proposal intends to solve
- What capability users will gain

---

## Motivation

### Problem

Explain why this feature is needed:

- Who encounters the problem
- In what scenario it occurs
- What the current behavior is
- Why the current solution is insufficient

### Example

```text
Current:
User -> Existing behavior -> Problem

Expected:
User -> New behavior -> Result
```

---

## Goals

This PRD aims to deliver:

- [Goal 1]
- [Goal 2]
- [Goal 3]

Describe outcomes and capabilities, not implementation details.

## Non-Goals

This phase does not cover:

- [Non-goal 1]
- [Non-goal 2]
- [Future capability]

---

## User Experience

### Basic Usage

```ts
// Example usage
```

### Expected Flow

1. The user performs `[Action]`
2. The system receives `[Input]`
3. The system performs `[Behavior]`
4. The user receives `[Result]`

---

## Behavior

Define stable product behavior rather than a specific implementation.

### [Scenario Name]

**Given**

```text
Precondition
```

**When**

```text
User action
```

**Then**

```text
Expected result
```

### Rules

1. `[Rule 1]`
2. `[Rule 2]`
3. `[Rule 3]`

Rules should be:

- Explicit
- Testable
- As independent of implementation as possible

---

## Scope

### Included

- `[Capability A]`
- `[Capability B]`

### Excluded

- `[Capability X]`
- `[Capability Y]`

---

## Public API

> Remove this section when there is no public API.

```ts
export interface ExampleConfig {
  enabled?: boolean;
}
```

| Field     | Type      | Default | Description                    |
| --------- | --------- | ------- | ------------------------------ |
| `enabled` | `boolean` | `false` | Whether the feature is enabled |

Clarify:

- Public and internal API boundaries
- Default behavior
- Whether a breaking change exists

---

## Configuration

> Remove this section when configuration is not involved.

```yaml
feature:
  enabled: true
```

For nested configuration, document the resolution order:

```text
Package
  |
Workspace
  |
Global
  |
Default
```

Configuration rules:

- `[Rule 1]`
- `[Rule 2]`

---

## Compatibility

Describe the impact on existing users after upgrading.

### Existing Behavior

```text
Current behavior
```

### New Behavior

```text
New behavior
```

Answer:

- Does existing configuration remain valid?
- Is the existing API compatible?
- Is migration required?
- Does the default behavior change?
- Is there a breaking change?

> What happens if a user upgrades without changing anything?

---

## Edge Cases

| Scenario              | Expected Behavior |
| --------------------- | ----------------- |
| Missing data          | `[Behavior]`      |
| Invalid input         | `[Behavior]`      |
| Conflict              | `[Behavior]`      |
| IO / network failure  | `[Behavior]`      |
| Concurrent operations | `[Behavior]`      |

---

## Design Constraints

Record architectural boundaries that must be respected without describing the complete implementation.

Examples:

- Core must not depend on UI
- Runtime must not depend on a specific host
- The config package must not contain business configuration definitions
- The source of truth remains append-only
- Browser packages must not depend on Node-only APIs

Put the complete implementation plan in an RFC or design document.

---

## Open Questions

Unresolved questions:

- `[Question 1]`
- `[Question 2]`

---

## Implementation Plan

### Phase 1 - Core

- [ ] Define the core model / API
- [ ] Implement core behavior
- [ ] Add core tests

### Phase 2 - Integration

- [ ] Integrate with existing modules
- [ ] Complete compatibility logic
- [ ] Add integration tests

### Phase 3 - Polish

- [ ] Cover exceptions and edge cases
- [ ] Update documentation and examples

Each task should have an unambiguous completion condition.

Recommended:

```text
- [ ] Package config overrides workspace config
```

Avoid:

```text
- [ ] Improve configuration
```

---

## Acceptance Criteria

- [ ] Core user scenarios work end to end
- [ ] Rules have corresponding tests
- [ ] Edge case behavior matches this PRD
- [ ] Public API matches its definition
- [ ] No undeclared breaking change exists
- [ ] Required documentation is updated

---

## Contributor Notes

> Optional.

### Relevant Packages

```text
packages/
|-- core/
|-- config/
`-- ...
```

### Entry Points

- `packages/...` - `[Responsibility]`
- `packages/...` - `[Responsibility]`

### Development

```bash
pnpm install
pnpm test
pnpm dev
```

---

## Decisions

> Record only important decisions that have been finalized.

### YYYY-MM-DD - [Decision]

**Decision:** `[Final choice]`

**Reason:** `[Why this choice was made]`

**Alternatives:** `[Other options considered]`

---

## Future Work

- `[Future capability 1]`
- `[Future capability 2]`

---

## Changelog

| Date       | Change           |
| ---------- | ---------------- |
| YYYY-MM-DD | Initial proposal |
