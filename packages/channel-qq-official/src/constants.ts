/** 保留既有部署默认网关，新部署可用 apiBaseUrl 选择官方统一域名 */
export const QQ_OFFICIAL_API_BASE_URL = "https://api.sgroup.qq.com";
/** 保留既有凭据端点默认值，迁移使用显式配置而不静默改变已有部署 */
export const QQ_OFFICIAL_TOKEN_ENDPOINT = "https://bots.qq.com/app/getAppAccessToken";
/** 官方文档当前统一 API 域名，平台凭据始终只在服务端使用 */
export const QQ_OFFICIAL_UNIFIED_API_BASE_URL = "https://api.bot.qq.com";
/** 官方文档当前统一令牌端点，不能将 access_token 传给 WebUI */
export const QQ_OFFICIAL_UNIFIED_TOKEN_ENDPOINT = "https://api.bot.qq.com/app/getAppAccessToken";
