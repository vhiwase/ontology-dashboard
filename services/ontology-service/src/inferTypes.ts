/**
 * Column types for data that arrived without a schema.
 *
 * Two sources need this and neither has a catalogue to read a type from: a
 * REST response, which is JSON, and a Python transform's result, which is a
 * list of dicts. Both land in a real table, so both need a column type per
 * field, and the only evidence available is the values themselves.
 *
 * ── the rule ────────────────────────────────────────────────────────────────
 * A column is given a narrow type only when EVERY non-null value in it fits.
 * One string among the numbers makes the whole column text — which is lossless,
 * where the reverse would not be. Nulls alone give text, because nothing was
 * learned; calling an all-null column `bigint` would be a guess dressed as a
 * fact.
 *
 * Decimal values cross as strings so their precision survives the JSON round
 * trip (a freight charge of 1200212.47 must not come back as
 * 1200212.469999999), so a string of digits still counts as a number here.
 */

export interface InferredColumn {
	name: string;
	type: string;
}

export function columnTypeFor(values: unknown[]): string {
	let sawNumber = false;
	let sawInteger = true;
	let sawBoolean = false;
	let sawStructure = false;
	let sawOther = false;
	let sawAny = false;

	for (const value of values) {
		if (value === null || value === undefined) continue;
		sawAny = true;
		if (typeof value === "boolean") {
			sawBoolean = true;
		} else if (typeof value === "number") {
			sawNumber = true;
			if (!Number.isInteger(value)) sawInteger = false;
		} else if (typeof value === "object") {
			sawStructure = true;
		} else if (typeof value === "string") {
			if (/^-?\d+(\.\d+)?$/.test(value)) {
				sawNumber = true;
				if (value.includes(".")) sawInteger = false;
			} else {
				sawOther = true;
			}
		} else {
			sawOther = true;
		}
	}

	if (!sawAny) return "text";
	if (sawStructure && !sawOther && !sawNumber && !sawBoolean) return "jsonb";
	if (sawStructure || sawOther) return "text";
	if (sawBoolean && !sawNumber) return "boolean";
	if (sawNumber && !sawBoolean) return sawInteger ? "bigint" : "numeric";
	return "text";
}

/**
 * The columns of a set of rows, in the order they were first seen.
 *
 * Union rather than "the first row's keys": a REST payload routinely omits a
 * null field, and taking the first record as the schema would drop a column
 * every later record has.
 */
export function columnsOfRows(rows: Array<Record<string, unknown>>): InferredColumn[] {
	const names: string[] = [];
	for (const row of rows) {
		for (const key of Object.keys(row)) {
			if (!names.includes(key)) names.push(key);
		}
	}
	return names.map((name) => ({
		name,
		type: columnTypeFor(rows.map((row) => row[name])),
	}));
}

/**
 * A field name from outside, checked before it can become an identifier.
 *
 * JSON keys are not SQL identifiers: they hold spaces, dots, dashes and case.
 * Normalised to snake_case rather than refused, because refusing would make
 * most real REST payloads unsyncable — but the result is still verified, so
 * nothing unrepresentable reaches a CREATE TABLE.
 */
export function normaliseColumnName(name: string, index: number): string {
	const cleaned = name
		.trim()
		.replace(/([a-z0-9])([A-Z])/g, "$1_$2")
		.toLowerCase()
		.replace(/[^a-z0-9_]+/g, "_")
		.replace(/^_+|_+$/g, "")
		.slice(0, 63);

	// A key of punctuation alone, or one starting with a digit, still has to
	// become something addressable.
	if (!cleaned) return `field_${index + 1}`;
	if (/^[0-9]/.test(cleaned)) return `f_${cleaned}`;
	return cleaned;
}
