/**
 * Where a connection in a personal workspace may point.
 *
 * In a shared space a connection is created by someone the team trusts with
 * the platform. In a personal workspace it is created by whoever registered,
 * and this service will dial whatever host they type. Three things follow:
 *
 *   * the platform's OWN database is refused - every workspace's synced
 *     tables live there, and a connection to it with guessed or leaked
 *     credentials would read all of them;
 *   * link-local addresses are refused, which is where cloud instance metadata
 *     (169.254.169.254) answers with credentials of its own;
 *   * private and loopback ranges are refused only when
 *     BLOCK_PRIVATE_CONNECTION_HOSTS=true. Off by default, because the common
 *     deployment is one company connecting the databases on its own network,
 *     and blocking those would block the product's main use. A multi-tenant
 *     deployment should turn it on.
 *
 * The host is resolved once, checked, and the ADDRESS is what the driver
 * connects to, so a name that resolves differently a second later (DNS
 * rebinding) cannot slip past the check.
 */

import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import { pool } from "./db";
import { BadRequest } from "./registry";

export const BLOCK_PRIVATE_HOSTS =
	(process.env.BLOCK_PRIVATE_CONNECTION_HOSTS ?? "false").trim().toLowerCase() === "true";

function ipv4Parts(ip: string): number[] | null {
	const parts = ip.split(".").map(Number);
	return parts.length === 4 && parts.every((p) => Number.isInteger(p) && p >= 0 && p <= 255) ? parts : null;
}

/** An IPv4-mapped IPv6 address (::ffff:10.0.0.1) as its IPv4 form. */
function unmapped(ip: string): string {
	const match = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(ip);
	return match ? match[1]! : ip;
}

export function isLinkLocal(address: string): boolean {
	const ip = unmapped(address);
	const v4 = ipv4Parts(ip);
	if (v4) return v4[0] === 169 && v4[1] === 254;
	return /^fe[89ab][0-9a-f]:/i.test(ip);
}

export function isLoopback(address: string): boolean {
	const ip = unmapped(address);
	const v4 = ipv4Parts(ip);
	if (v4) return v4[0] === 127;
	return ip === "::1";
}

export function isPrivateAddress(address: string): boolean {
	const ip = unmapped(address);
	const v4 = ipv4Parts(ip);
	if (v4) {
		const [a, b] = v4 as [number, number, number, number];
		return (
			a === 10 ||
			a === 127 ||
			a === 0 ||
			(a === 172 && b >= 16 && b <= 31) ||
			(a === 192 && b === 168) ||
			(a === 169 && b === 254) ||
			(a === 100 && b >= 64 && b <= 127)
		);
	}
	const lower = ip.toLowerCase();
	return lower === "::1" || lower === "::" || /^f[cd][0-9a-f]{2}:/.test(lower) || isLinkLocal(lower);
}

async function addressesOf(host: string): Promise<string[]> {
	if (isIP(host)) return [host];
	try {
		const found = await lookup(host, { all: true });
		return found.map((entry) => entry.address);
	} catch {
		throw new BadRequest(`'${host}' does not resolve to an address.`);
	}
}

/** Host and port of the platform's own database, from the pool's DSN. */
export function platformDatabaseAddress(): { host: string; port: number } | null {
	const dsn = (pool as unknown as { options?: { connectionString?: string } }).options?.connectionString;
	if (!dsn) return null;
	try {
		const url = new URL(dsn);
		return { host: url.hostname, port: Number(url.port) || 5432 };
	} catch {
		return null;
	}
}

/**
 * Check a host for a personal workspace and return the address to dial.
 *
 * `kind` decides whether the platform database rule applies: it is a
 * PostgreSQL rule, and a REST call to the same host is a different service.
 */
export async function vetHost(
	host: string,
	port: number,
	kind: "postgresql" | "rest",
): Promise<string> {
	const addresses = await addressesOf(host);
	if (addresses.length === 0) throw new BadRequest(`'${host}' does not resolve to an address.`);

	if (addresses.some(isLinkLocal)) {
		throw new BadRequest(
			`'${host}' resolves to a link-local address, which is where cloud instance metadata ` +
				"answers. Connections from a personal workspace cannot reach it.",
		);
	}
	if (BLOCK_PRIVATE_HOSTS && addresses.some(isPrivateAddress)) {
		throw new BadRequest(
			`'${host}' resolves to a private address, and this deployment only lets personal ` +
				"workspaces reach public hosts (BLOCK_PRIVATE_CONNECTION_HOSTS=true).",
		);
	}

	if (kind === "postgresql") {
		const platform = platformDatabaseAddress();
		if (platform && platform.port === port) {
			const platformAddresses = await addressesOf(platform.host).catch(() => [platform.host]);
			const same =
				addresses.some((a) => platformAddresses.includes(a)) ||
				(addresses.some(isLoopback) && platformAddresses.some(isLoopback));
			if (same) {
				throw new BadRequest(
					"That is the platform's own database server. A personal workspace connects to " +
						"your databases, not to the one every workspace's data is stored in.",
				);
			}
		}
	}
	// Dial the address that was checked, not the name, so the check cannot be
	// raced by a resolver that answers differently the second time.
	return addresses[0]!;
}
