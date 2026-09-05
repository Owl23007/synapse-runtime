import { z } from "zod";

/** 可选密钥，将空字符串视为未配置以兼容空环境变量回退值 */
export const OptionalSecretSchema = z.preprocess(
  (value) => (value === "" ? undefined : value),
  z.string().min(1).optional()
);
