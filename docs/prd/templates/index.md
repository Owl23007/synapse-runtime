# PRD Authoring Guide

本目录包含 PRD 的可复制模板和文档系统规范：

```text
template/
├── index.md            # 模板说明、formatter 规则、字段语义、使用方式
├── template.cn.md      # 中文 PRD 模板
└── template.en.md      # 英文 PRD 模板
```

`index.md` 解释的是文档系统如何读取和展示 PRD，不属于任何一个具体 PRD 的正文。创建新文档时，应复制对应语言的模板，再按实际需求填写内容。

## Frontmatter

PRD 可以在正文前使用 YAML frontmatter 描述元数据：

```yaml
---
id: feature-id
status: wip
lang: zh-CN
progress: 40
translations:
  en: ./feature.en.md
links:
  issues:
    - https://github.com/example/project/issues/1
  discussions: []
  rfcs: []
  docs: []
  implementations: []
---
```

### `status`

`status` 表示 PRD 的生命周期阶段，可用值如下：

| 值            | 含义                                        |
| ------------- | ------------------------------------------- |
| `wip`         | 规划中，内容或范围仍在完善                  |
| `next`        | 已列入后续计划，但尚未开始实施              |
| `in-progress` | 正在设计、开发或验证                        |
| `completed`   | 当前迭代已完成，仍保留在活跃 PRD 中用于复盘 |
| `archived`    | 已完成且不再维护的历史文档                  |

状态只表达阶段，不替代任务进度。`status` 缺失或不是上述值时，formatter 会根据 `progress` 推断：进度为 100 时显示为 `completed`，否则显示为 `wip`。

### `progress`

`progress` 是可选的手工进度，取 0 到 100 的数字。存在有效的 `progress` 时，它优先于任务列表；formatter 会将其四舍五入并限制在 0～100 之间。

没有显式 `progress` 时，formatter 按任务列表计算：

```text
已完成任务数 / 已识别任务总数 × 100
```

结果四舍五入为整数。没有任何可识别任务时，进度为“待标注”，而不是 0%。设计型 PRD 可以使用显式 `progress` 表达不适合拆成 checkbox 的完成度。

### Checkbox 统计规则

formatter 只统计独立列表项中的以下形式：

```markdown
- [x] 已完成任务
- [x] 同样视为已完成
- [ ] 待完成任务

* [ ] 使用其他列表标记也会被统计

- [x] 使用加号列表标记也会被统计
```

其中 `[x]` 或 `[X]` 计入已完成任务，`[ ]` 计入待完成任务。普通正文中的方括号、代码示例中的 checkbox、其他状态标记以及没有列表标记的文本不会被统计。所有章节中的匹配项都会计入，因此说明性示例和不需要参与进度的章节不应放置这类 checkbox。

## 归档

将不再维护的 PRD 移入 `docs/prd/archive/`。formatter 会优先根据路径将其中的文档标记为 `archived`，即使 frontmatter 中仍是其他状态也会显示为归档。

归档前建议同步设置：

```yaml
status: archived
```

这样可以保留文档自身的状态语义。归档目录中的文档不会作为当前路线图中的活动文档维护。

## 语言与翻译

`lang` 标记当前文件的语言，应使用稳定的 locale，例如 `zh-CN` 或 `en`：

```yaml
lang: zh-CN
```

`translations` 是从语言代码到相对文件路径的映射。路径相对于当前 PRD 文件所在目录：

```yaml
translations:
  en: ./feature.en.md
```

多语言版本应共享同一个 `id`，并尽量保持标题、章节和任务语义一致。翻译文件是独立的 PRD 文档，各自的 frontmatter 都应声明对应的 `lang`；没有翻译时可以省略 `translations`。

## Links

`links` 用于集中记录 PRD 关联资料。当前支持以下类型，每种类型均使用 URL 或仓库内相对路径的数组：

| 类型              | 用途                              |
| ----------------- | --------------------------------- |
| `issues`          | Issue、缺陷或需求跟踪项           |
| `discussions`     | 讨论、决策或评审线程              |
| `rfcs`            | RFC、设计提案或架构说明           |
| `docs`            | 用户文档、参考资料或外部规范      |
| `implementations` | 实现代码、Pull Request 或变更入口 |

没有关联项时保留空数组，避免把链接写进正文后难以统一查找。

## 新建 PRD

1. 选择语言，复制对应模板；中文使用 `template.cn.md`，英文使用 `template.en.md`
2. 将文件放在 `docs/prd/` 下，并使用描述功能的 kebab-case 文件名，例如 `message-routing-prd.md`
3. 修改 `id`、标题、`lang`、翻译映射和关联链接，删除不适用的可选章节
4. 用目标、行为、范围和验收标准描述产品结果，不把实现细节写成需求结论
5. 将可验证的实施工作写成 checkbox；若不适合用任务列表表达进度，则设置显式 `progress`
6. 在 [`docs/prd/index.md`](../index.md) 中补充活动 PRD 入口，归档后移除活动入口并放入 `archive/`
7. 构建文档站，确认 frontmatter、路线图进度、翻译链接和页面目录均正确

## Formatter Fallback

路线图 formatter 会尽量从不完整的文档生成摘要：

- 缺少 frontmatter 时，仍会从一级标题生成标题，并按任务列表计算进度
- 缺少一级标题时，使用文件名作为标题；连文件名也不可用时使用“未命名 PRD”
- 缺少或不支持的 `status` 时，进度为 100 使用 `completed`，其他情况使用 `wip`
- 文档路径包含 `/archive/` 时，无条件使用 `archived`
- 没有任务且没有显式 `progress` 时，进度为 `null`，路线图显示为待标注
- 显式 `progress` 即使超出范围也会被规范化到 0～100

fallback 用于让旧文档和草稿仍可被展示，不代表可以省略清晰的 frontmatter。正式 PRD 应主动声明状态、语言和必要的关联信息。

## 模板维护约定

- `index.md` 维护文档系统规范、字段语义和 formatter 行为
- `template.cn.md` 与 `template.en.md` 只提供可复制的 PRD 结构和占位内容，不解释 formatter 实现
- 规则发生变化时，先更新 formatter，再同步更新本指南和必要的模板元数据
- 两种语言模板应保持章节结构基本一致；新增章节时同步维护另一种语言
- 模板中的示例 checkbox 只保留在确实希望复制到新 PRD 的实施计划或验收标准中
- 维护模板时不要把某个具体 PRD 的背景、决定或实现结论带入模板
- 若未来语言数量增加，可将文件重命名为 `zh-CN.md`、`en.md`，或采用 `README.md` 加语言模板的结构，并同步更新本指南中的路径
