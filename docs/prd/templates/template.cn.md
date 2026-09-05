---
id: feature-id
status: wip
lang: zh-CN

translations:
  en: ./template.en.md

links:
issues: []
discussions: []
rfcs: []
docs: []
implementations: []
---

# [Feature Name]

> 一句话说明这个功能解决什么问题，以及最终提供什么能力。

## Summary

用 3～5 句话说明：

- 当前存在什么问题
- 本次准备解决什么
- 用户最终获得什么能力

## Motivation

### Problem

说明为什么需要这个功能：

- 谁遇到了问题
- 在什么场景下发生
- 当前行为是什么
- 当前方案为什么不足

### Example

```text
Current:
User → Existing behavior → Problem

Expected:
User → New behavior → Result
```

## Goals

本 PRD 希望实现：

- [Goal 1]
- [Goal 2]
- [Goal 3]

这里描述**结果和能力**，而不是具体实现。

## Non-Goals

本阶段明确不处理：

- [Non-goal 1]
- [Non-goal 2]
- [Future capability]

## User Experience

### Basic Usage

```ts
// Example usage
```

### Expected Flow

1. 用户执行 `[Action]`
2. 系统接收 `[Input]`
3. 系统执行 `[Behavior]`
4. 用户获得 `[Result]`

## Behavior

定义稳定的产品行为，而不是具体实现方式。

### [Scenario Name]

**Given**

```text
前置状态
```

**When**

```text
用户行为
```

**Then**

```text
预期结果
```

### Rules

1. `[Rule 1]`
2. `[Rule 2]`
3. `[Rule 3]`

规则应当：

- 明确
- 可测试
- 尽量与具体实现无关

## Scope

### Included

- `[Capability A]`
- `[Capability B]`

### Excluded

- `[Capability X]`
- `[Capability Y]`

## Public API

> 没有公共 API 时删除本节。

```ts
export interface ExampleConfig {
  enabled?: boolean;
}
```

| Field     | Type      | Default | Description  |
| --------- | --------- | ------- | ------------ |
| `enabled` | `boolean` | `false` | 是否启用功能 |

需要明确：

- Public / Internal API 边界
- 默认行为
- 是否存在 Breaking Change

## Configuration

> 不涉及配置时删除本节。

```yaml
feature:
  enabled: true
```

如果存在多级配置，明确解析优先级：

```text
Package
  ↓
Workspace
  ↓
Global
  ↓
Default
```

配置规则：

- `[Rule 1]`
- `[Rule 2]`

## Compatibility

说明升级后对已有用户的影响。

### Existing Behavior

```text
当前行为
```

### New Behavior

```text
新行为
```

需要回答：

- 旧配置是否继续有效
- 旧 API 是否兼容
- 是否需要 Migration
- 默认行为是否变化
- 是否存在 Breaking Change

> 用户升级后，如果什么都不修改，会发生什么？

## Edge Cases

| Scenario              | Expected Behavior |
| --------------------- | ----------------- |
| Missing data          | `[Behavior]`      |
| Invalid input         | `[Behavior]`      |
| Conflict              | `[Behavior]`      |
| IO / Network failure  | `[Behavior]`      |
| Concurrent operations | `[Behavior]`      |

## Design Constraints

记录必须遵守的架构边界，不描述完整实现。

例如：

- Core 不依赖 UI
- Runtime 不依赖具体宿主
- Config package 不包含业务配置定义
- Source of truth 保持 append-only
- Browser package 不依赖 Node-only API

完整实现方案放入 RFC / Design Document。

## Open Questions

尚未确定的问题：

- `[Question 1]`
- `[Question 2]`

## Implementation Plan

### Phase 1 — Core

- [ ] 定义核心模型 / API
- [ ] 实现核心行为
- [ ] 添加核心测试

### Phase 2 — Integration

- [ ] 接入现有模块
- [ ] 完成兼容逻辑
- [ ] 添加集成测试

### Phase 3 — Polish

- [ ] 补充异常和边界处理
- [ ] 更新文档和示例

任务应该能够明确判断是否完成。

推荐：

```text
- [ ] Package config overrides workspace config
```

避免：

```text
- [ ] 完善配置功能
```

## Acceptance Criteria

- [ ] 核心用户场景可以完整运行
- [ ] Rules 有对应测试
- [ ] Edge Cases 行为符合 PRD
- [ ] Public API 与定义一致
- [ ] 不存在未声明的 Breaking Change
- [ ] 必要文档已更新

## Contributor Notes

> 可选。

### Relevant Packages

```text
packages/
├── core/
├── config/
└── ...
```

### Entry Points

- `packages/...` — `[职责]`
- `packages/...` — `[职责]`

### Development

```bash
pnpm install
pnpm test
pnpm dev
```

## Decisions

> 仅记录重要且已经确定的决策。

### YYYY-MM-DD — [Decision]

**Decision:** `[最终选择]`

**Reason:** `[选择原因]`

**Alternatives:** `[其他考虑过的方案]`

## Future Work

- `[Future capability 1]`
- `[Future capability 2]`

## Changelog

| Date       | Change           |
| ---------- | ---------------- |
| YYYY-MM-DD | Initial proposal |
