import { lookup as lookupDns } from "node:dns/promises";
import { isIP } from "node:net";
import type { WebDnsAddress, WebDnsLookup } from "./types.js";

export interface WebTargetPolicy {
  readonly allowedDomains: readonly string[];
  readonly deniedDomains: readonly string[];
  readonly allowPrivateNetwork: boolean;
  readonly lookup: WebDnsLookup;
}

/** 校验 Web 请求目标是否符合域名与网络策略 */
export async function assertFetchTarget(url: URL, options: WebTargetPolicy): Promise<void> {
  assertHttpUrl(url);
  const hostname = normalizeHostname(url.hostname);
  if (options.deniedDomains.some((domain) => domainMatches(hostname, domain))) {
    throw new Error(`Web access to domain "${hostname}" is denied`);
  }
  if (options.allowedDomains.length > 0 && !options.allowedDomains.some((domain) => domainMatches(hostname, domain))) {
    throw new Error(`Web access to domain "${hostname}" is not allowed`);
  }
  await assertPublicTarget(url, options.allowPrivateNetwork, options.lookup);
}

/** 校验 URL 是否使用受支持且不包含凭据的 HTTP 协议 */
export function assertHttpUrl(url: URL): void {
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("Web tools only support HTTP and HTTPS URLs");
  }
  if (url.username.length > 0 || url.password.length > 0) {
    throw new Error("Web URLs must not contain embedded credentials");
  }
}

/** 校验 Web 请求目标不会解析到私有或保留地址 */
export async function assertPublicTarget(url: URL, allowPrivateNetwork: boolean, lookup: WebDnsLookup): Promise<void> {
  assertHttpUrl(url);
  if (allowPrivateNetwork) {
    return;
  }
  const hostname = normalizeHostname(url.hostname);
  if (hostname === "localhost" || hostname.endsWith(".localhost") || hostname.endsWith(".local")) {
    throw new Error(`Web access to private host "${hostname}" is denied`);
  }
  if (isIP(hostname) !== 0) {
    if (isPrivateOrReservedIp(hostname)) {
      throw new Error(`Web access to private address "${hostname}" is denied`);
    }
    return;
  }
  const addresses = await lookup(hostname);
  if (addresses.length === 0) {
    throw new Error(`Web host "${hostname}" did not resolve to an address`);
  }
  const blocked = addresses.find((entry) => isPrivateOrReservedIp(entry.address));
  if (blocked !== undefined) {
    throw new Error(`Web host "${hostname}" resolves to blocked address "${blocked.address}"`);
  }
}

function isPrivateOrReservedIp(address: string): boolean {
  const normalized = address.toLowerCase();
  if (normalized.startsWith("::ffff:")) {
    return isPrivateOrReservedIp(normalized.slice("::ffff:".length));
  }
  if (isIP(normalized) === 4) {
    const parts = normalized.split(".").map(Number);
    const first = parts[0] ?? 0;
    const second = parts[1] ?? 0;
    return (
      first === 0 ||
      first === 10 ||
      first === 127 ||
      (first === 100 && second >= 64 && second <= 127) ||
      (first === 169 && second === 254) ||
      (first === 172 && second >= 16 && second <= 31) ||
      (first === 192 && second === 0) ||
      (first === 192 && second === 168) ||
      (first === 192 && second === 0 && parts[2] === 2) ||
      (first === 198 && (second === 18 || second === 19 || second === 51)) ||
      (first === 203 && second === 0 && parts[2] === 113) ||
      first >= 224
    );
  }
  if (isIP(normalized) === 6) {
    return (
      normalized === "::" ||
      normalized === "::1" ||
      normalized.startsWith("fc") ||
      normalized.startsWith("fd") ||
      /^fe[89ab]/u.test(normalized) ||
      normalized.startsWith("ff") ||
      normalized.startsWith("2001:db8")
    );
  }
  return true;
}

/** 判断主机名是否属于指定域名 */
export function domainMatches(hostname: string, domain: string): boolean {
  return hostname === domain || hostname.endsWith(`.${domain}`);
}

/** 归一化域名列表并去重 */
export function normalizeDomains(values: readonly string[]): readonly string[] {
  return [...new Set(values.map((value) => value.trim().toLowerCase().replace(/^\.+/u, "")).filter(Boolean))];
}

/** 归一化 URL 主机名 */
export function normalizeHostname(value: string): string {
  const normalized = value.trim().toLowerCase();
  return normalized.startsWith("[") && normalized.endsWith("]") ? normalized.slice(1, -1) : normalized;
}

/** 使用系统 DNS 解析全部目标地址 */
export async function defaultLookup(hostname: string): Promise<readonly WebDnsAddress[]> {
  return lookupDns(hostname, { all: true, verbatim: true });
}
