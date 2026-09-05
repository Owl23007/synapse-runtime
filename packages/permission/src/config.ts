import { z } from "zod";

/**
 * 生产配置接口接受的策略
 *
 * permission 包仍然对未来的工作流状态进行建模，但运行时目前还不会持久化或恢复这些状态
 * 在这里暴露这些值会使 `confirm`、`sandbox` 和 `rate_limit` 变成无法区分的拒绝结果
 */
export const PermissionPolicySchema = z.enum(["allow", "deny"]);

/** 风险等级模式 */
export const RiskLevelSchema = z.enum(["low", "medium", "high"]);

/** 生产环境权限策略 */
export type PermissionPolicy = z.infer<typeof PermissionPolicySchema>;

/** 风险等级 */
export type RiskLevel = z.infer<typeof RiskLevelSchema>;
