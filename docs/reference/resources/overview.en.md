# Resources and capabilities

Synapse reuses its persistent Workspace model for resource ownership. Native sessions bind to a resource workspace and may share it. Channel file discovery uses the same identity and workspace resolution as conversations.

Files separates logical assets, stable sources, immutable content versions and references. QQ notices index metadata without downloading bytes, storing surrounding untriggered message text or creating a Run. Preview and Agent reads materialize content on demand. Native uploads initialize through JSON and then send bounded raw binary with an idempotency key, protected by existing Admin authentication.

Content is staged, hashed, type-detected and atomically published before a version is committed. Runs pin exact version IDs and SHA256 values. Replacing or soft-deleting an asset preserves historical references. Selected execution artifacts are copied into Files while retaining the existing selection and delivery receipt lifecycle.

The Files page supports workspace/source filters, uploads, previews, downloads, versions, local renaming/deletion, sources and Run links. asset.search returns metadata; asset.read paginates text and bounded PDF extraction. Other binary formats return version metadata. Readonly mounts expose live views; saving or using a file creates an immutable snapshot. Traversal, hidden sensitive paths, links and writes are rejected. Public URLs require explicit approval, and Agent mount access has a separate permission.

Runtime installs capabilities; workspaces select exact installed versions. Standard Agent Skills use SKILL.md and progressive resource reads. They grant no tool permissions, and scripts are not executed. ClawHub releases and GitHub commits become digest-addressed local snapshots. Discovery, installation, enablement and invocation are separate. Update checks never automatically install or activate a release. Rollback switches the workspace pointer and retains older snapshots.

Remote MCP uses the official v2 Client over Streamable HTTP. Hosts must be approved and credentials referenced through deployment environment variables. Visibility and calls recheck workspace policy and user permissions. Schemas, budgets, protocol negotiation and observed server versions are tracked. Unknown outcomes of non-idempotent calls are not retried or replayed. Remote behavior is observed, not claimed to be fully reproducible.

Run details expose dependency snapshots and existing PromptBundle tool/skill digests. Passive discovery does not generate artificial DAG nodes. Storage has a hard quota; historical blobs are not automatically evicted. Local stdio, Skill script execution, isolated Office preview conversion and additional catalog/storage operations are optional follow-ups.

Configuration and API references are available in the Chinese [Files](./overview) and [Capabilities](../capabilities/overview) pages.
