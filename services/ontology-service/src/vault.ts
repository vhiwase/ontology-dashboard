/**
 * The credential vault: passwords typed into the connection form, encrypted.
 *
 * Connections have always referred to their credential rather than holding
 * it: the NAME of an environment variable, or the PATH of a Docker secret.
 * That is right for a team that administers its own server, and impossible for
 * a person who has just registered - they cannot set an environment variable
 * on someone else's machine. Worse, honouring such a reference from a personal
 * workspace would let anyone who can register point a connection at a host of
 * their own and have this service send it, say, /run/secrets/postgres_password.
 *
 * So a personal workspace stores its credentials here instead:
 *
 *   * AES-256-GCM, with a random IV per credential and the GCM tag checked on
 *     every read, so a tampered row fails rather than decrypting to garbage;
 *   * the key is never in the database - it comes from CREDENTIAL_KEY_FILE
 *     (or CREDENTIAL_KEY), or is derived from the JWT secret with HKDF when
 *     neither is set, and a fingerprint of it is stored beside each row so a
 *     rotated key is reported as a rotated key;
 *   * a credential belongs to one space, and is only ever decrypted for a
 *     request scoped to that space;
 *   * it is never returned by any API. The connection holds `vault:<id>`.
 */

import { createCipheriv, createDecipheriv, createHash, hkdfSync, randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { query, queryOne } from "./db";
import { BadRequest } from "./registry";

const VAULT_PREFIX = "vault:";

interface VaultKey {
	key: Buffer;
	id: string;
	derived: boolean;
}

function decodeKeyMaterial(raw: string): Buffer {
	const value = raw.trim();
	if (/^[0-9a-fA-F]{64}$/.test(value)) return Buffer.from(value, "hex");
	const asBase64 = Buffer.from(value, "base64");
	if (asBase64.length === 32 && /^[A-Za-z0-9+/=_-]+$/.test(value)) return asBase64;
	if (value.length < 32) {
		throw new Error("CREDENTIAL_KEY must be 32 bytes (64 hex characters) or at least 32 characters of key material.");
	}
	// Longer free-form material is stretched to a key rather than truncated.
	return Buffer.from(hkdfSync("sha256", value, "ontology-dashboard", "credential-vault/v1", 32));
}

function jwtSecret(): string {
	const file = process.env.AUTH_JWT_SECRET_FILE;
	if (file) return readFileSync(file, "utf8").trim();
	return process.env.AUTH_JWT_SECRET ?? "";
}

let loaded: VaultKey | null = null;

/** The key, loaded once. Exposed for tests through __testing. */
function vaultKey(): VaultKey {
	if (loaded) return loaded;
	let key: Buffer;
	let derived = false;
	const file = process.env.CREDENTIAL_KEY_FILE;
	if (file) {
		key = decodeKeyMaterial(readFileSync(file, "utf8"));
	} else if (process.env.CREDENTIAL_KEY) {
		key = decodeKeyMaterial(process.env.CREDENTIAL_KEY);
	} else {
		const secret = jwtSecret();
		if (secret.length < 32) {
			throw new Error("No CREDENTIAL_KEY_FILE and no usable JWT secret to derive a vault key from.");
		}
		key = Buffer.from(hkdfSync("sha256", secret, "ontology-dashboard", "credential-vault/v1", 32));
		derived = true;
		console.warn(
			JSON.stringify({
				level: "warn",
				message:
					"Credential vault key derived from the JWT secret. Set CREDENTIAL_KEY_FILE so rotating " +
					"the JWT secret does not also make every stored connection password unreadable.",
			}),
		);
	}
	loaded = { key, id: createHash("sha256").update(key).digest("hex").slice(0, 16), derived };
	return loaded;
}

export function isVaultRef(ref: string | null | undefined): boolean {
	return typeof ref === "string" && ref.startsWith(VAULT_PREFIX);
}

function idOf(ref: string): number {
	const id = Number(ref.slice(VAULT_PREFIX.length));
	if (!Number.isInteger(id) || id <= 0) throw new BadRequest(`'${ref}' is not a vault reference.`);
	return id;
}

/** Encrypt a value. Exported for tests; storage goes through storeCredential. */
export function encrypt(plaintext: string): { ciphertext: string; iv: string; authTag: string; keyId: string } {
	const { key, id } = vaultKey();
	const iv = randomBytes(12);
	const cipher = createCipheriv("aes-256-gcm", key, iv);
	const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
	return {
		ciphertext: ciphertext.toString("base64"),
		iv: iv.toString("base64"),
		authTag: cipher.getAuthTag().toString("base64"),
		keyId: id,
	};
}

export function decrypt(sealed: { ciphertext: string; iv: string; authTag: string; keyId: string }): string {
	const { key, id } = vaultKey();
	if (sealed.keyId !== id) {
		throw new BadRequest(
			"This credential was encrypted with a different vault key than the one this service has now " +
				"(CREDENTIAL_KEY_FILE was changed, or the JWT secret it is derived from was rotated). " +
				"Enter the connection's password again.",
		);
	}
	const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(sealed.iv, "base64"));
	decipher.setAuthTag(Buffer.from(sealed.authTag, "base64"));
	try {
		return Buffer.concat([
			decipher.update(Buffer.from(sealed.ciphertext, "base64")),
			decipher.final(),
		]).toString("utf8");
	} catch {
		throw new BadRequest("A stored credential failed its integrity check and was not used.");
	}
}

/** Store a secret for a space and return the reference a connection keeps. */
export async function storeCredential(
	spaceId: number,
	label: string,
	secret: string,
	createdBy: string,
): Promise<string> {
	if (!secret) throw new BadRequest("An empty password cannot be stored.");
	if (secret.length > 4096) throw new BadRequest("That credential is too long to store.");
	const sealed = encrypt(secret);
	const row = await queryOne<{ credential_id: string }>(
		`INSERT INTO platform.credential (space_id, label, ciphertext, iv, auth_tag, key_id, created_by)
		 VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING credential_id::text`,
		[spaceId, label.slice(0, 200), sealed.ciphertext, sealed.iv, sealed.authTag, sealed.keyId, createdBy],
	);
	if (!row) throw new Error("Storing the credential returned no row.");
	return `${VAULT_PREFIX}${row.credential_id}`;
}

/**
 * Decrypt a credential for use by a connection in the given space.
 *
 * A reference from another space is answered exactly like a missing one, so
 * the vault cannot be used to probe which ids exist.
 */
export async function readCredential(ref: string, spaceSlug: string): Promise<string> {
	const row = await queryOne<{ ciphertext: string; iv: string; auth_tag: string; key_id: string; id: string }>(
		`SELECT c.credential_id::text AS id, c.ciphertext, c.iv, c.auth_tag, c.key_id
		   FROM platform.credential c JOIN platform.space s ON s.space_id = c.space_id
		  WHERE c.credential_id = $1 AND s.slug = $2`,
		[idOf(ref), spaceSlug],
	);
	if (!row) throw new BadRequest(`The stored credential ${ref} is not available in this space.`);
	const value = decrypt({ ciphertext: row.ciphertext, iv: row.iv, authTag: row.auth_tag, keyId: row.key_id });
	await query("UPDATE platform.credential SET last_used_at = now() WHERE credential_id = $1", [row.id]);
	return value;
}

export async function deleteCredential(ref: string, spaceSlug: string): Promise<void> {
	if (!isVaultRef(ref)) return;
	await query(
		`DELETE FROM platform.credential c USING platform.space s
		  WHERE s.space_id = c.space_id AND c.credential_id = $1 AND s.slug = $2`,
		[idOf(ref), spaceSlug],
	);
}

/** Internals for tests only. */
export const __testing = {
	decodeKeyMaterial,
	resetKey(): void {
		loaded = null;
	},
	keyInfo(): { id: string; derived: boolean } {
		const { id, derived } = vaultKey();
		return { id, derived };
	},
};
