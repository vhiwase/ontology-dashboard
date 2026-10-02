/**
 * Derived properties: arithmetic over the numeric properties of an object.
 *
 * "Line total = unit price × quantity × (1 − discount)" is the most common
 * thing a business needs that its tables do not store. It cannot be a metric
 * (a metric aggregates one column) and it must not be SQL the caller writes
 * (every workspace's tables share one database). So it is a tiny language,
 * parsed here into a tree and compiled back to SQL from that tree:
 *
 *   numbers, property names, + - * /, unary minus, parentheses, and the
 *   functions round, abs, coalesce, greatest, least, nullif
 *
 * A name must be one of the numeric columns the caller is allowed to use, and
 * is emitted quoted and qualified by the table it belongs to. A number is
 * emitted as a numeric literal from its parsed value, never from the input
 * text. Division is wrapped in NULLIF(divisor, 0), so a zero divisor gives
 * NULL rather than failing the whole query.
 */

import { BadRequest, quoteIdentifier } from "./registry";

export type Node =
	| { kind: "number"; value: number }
	| { kind: "column"; name: string }
	| { kind: "unary"; operand: Node }
	| { kind: "binary"; op: "+" | "-" | "*" | "/"; left: Node; right: Node }
	| { kind: "call"; fn: string; args: Node[] };

const FUNCTIONS: Record<string, { min: number; max: number }> = {
	round: { min: 1, max: 2 },
	abs: { min: 1, max: 1 },
	coalesce: { min: 2, max: 4 },
	greatest: { min: 2, max: 4 },
	least: { min: 2, max: 4 },
	nullif: { min: 2, max: 2 },
};

const MAX_LENGTH = 300;
const MAX_TOKENS = 80;

type Token =
	| { type: "number"; value: number }
	| { type: "name"; value: string }
	| { type: "op"; value: "+" | "-" | "*" | "/" }
	| { type: "paren"; value: "(" | ")" }
	| { type: "comma" };

export function tokenize(source: string): Token[] {
	if (source.length > MAX_LENGTH) throw new BadRequest(`An expression is at most ${MAX_LENGTH} characters.`);
	const tokens: Token[] = [];
	let i = 0;
	while (i < source.length) {
		const ch = source[i]!;
		if (/\s/.test(ch)) {
			i += 1;
			continue;
		}
		if (/[0-9.]/.test(ch)) {
			const match = /^(\d+(\.\d*)?|\.\d+)/.exec(source.slice(i));
			if (!match) throw new BadRequest(`Unexpected '${ch}' at position ${i + 1}.`);
			tokens.push({ type: "number", value: Number(match[0]) });
			i += match[0].length;
			continue;
		}
		if (/[A-Za-z_]/.test(ch)) {
			const match = /^[A-Za-z_][A-Za-z0-9_]*/.exec(source.slice(i))!;
			tokens.push({ type: "name", value: match[0] });
			i += match[0].length;
			continue;
		}
		if ("+-*/".includes(ch)) {
			tokens.push({ type: "op", value: ch as "+" | "-" | "*" | "/" });
		} else if (ch === "(" || ch === ")") {
			tokens.push({ type: "paren", value: ch });
		} else if (ch === ",") {
			tokens.push({ type: "comma" });
		} else {
			throw new BadRequest(`'${ch}' is not allowed in an expression. Use numbers, property names, + - * / and parentheses.`);
		}
		i += 1;
		if (tokens.length > MAX_TOKENS) throw new BadRequest("That expression is too long.");
	}
	return tokens;
}

/** Recursive descent: expr := term (('+'|'-') term)*, term := factor (('*'|'/') factor)*. */
export function parse(source: string): Node {
	const tokens = tokenize(source);
	let pos = 0;
	const peek = () => tokens[pos];
	const take = () => tokens[pos++];

	const expression = (): Node => {
		let node = term();
		for (let t = peek(); t?.type === "op" && (t.value === "+" || t.value === "-"); t = peek()) {
			take();
			node = { kind: "binary", op: t.value, left: node, right: term() };
		}
		return node;
	};
	const term = (): Node => {
		let node = factor();
		for (let t = peek(); t?.type === "op" && (t.value === "*" || t.value === "/"); t = peek()) {
			take();
			node = { kind: "binary", op: t.value, left: node, right: factor() };
		}
		return node;
	};
	const factor = (): Node => {
		const t = take();
		if (!t) throw new BadRequest("The expression ends too early.");
		if (t.type === "op" && t.value === "-") return { kind: "unary", operand: factor() };
		if (t.type === "op" && t.value === "+") return factor();
		if (t.type === "number") return { kind: "number", value: t.value };
		if (t.type === "paren" && t.value === "(") {
			const inner = expression();
			const close = take();
			if (close?.type !== "paren" || close.value !== ")") throw new BadRequest("A '(' is not closed.");
			return inner;
		}
		if (t.type === "name") {
			if (peek()?.type === "paren" && (peek() as { value: string }).value === "(") {
				const fn = t.value.toLowerCase();
				const spec = FUNCTIONS[fn];
				if (!spec) {
					throw new BadRequest(`'${t.value}' is not a function here. Available: ${Object.keys(FUNCTIONS).join(", ")}.`);
				}
				take();
				const args: Node[] = [];
				if (!(peek()?.type === "paren" && (peek() as { value: string }).value === ")")) {
					args.push(expression());
					while (peek()?.type === "comma") {
						take();
						args.push(expression());
					}
				}
				const close = take();
				if (close?.type !== "paren" || close.value !== ")") throw new BadRequest(`${fn}( is not closed.`);
				if (args.length < spec.min || args.length > spec.max) {
					throw new BadRequest(`${fn} takes ${spec.min === spec.max ? spec.min : `${spec.min} to ${spec.max}`} arguments.`);
				}
				return { kind: "call", fn, args };
			}
			return { kind: "column", name: t.value };
		}
		throw new BadRequest("The expression has an operator or comma where a value should be.");
	};

	const tree = expression();
	if (pos < tokens.length) throw new BadRequest("The expression has something left over after its end.");
	return tree;
}

/** Every column name the expression uses. */
export function columnsOf(node: Node): string[] {
	switch (node.kind) {
		case "column":
			return [node.name];
		case "unary":
			return columnsOf(node.operand);
		case "binary":
			return [...columnsOf(node.left), ...columnsOf(node.right)];
		case "call":
			return node.args.flatMap(columnsOf);
		default:
			return [];
	}
}

/**
 * Compile a parsed expression to SQL.
 *
 * `resolve` maps a name the caller used to the qualified SQL for that column
 * (e.g. `b."unit_price"`), or returns null when the name is not an allowed
 * numeric column - which refuses the expression.
 */
export function compile(node: Node, resolve: (name: string) => string | null): string {
	switch (node.kind) {
		case "number":
			if (!Number.isFinite(node.value)) throw new BadRequest("A number in the expression is not finite.");
			return `${node.value}::numeric`;
		case "column": {
			const sql = resolve(node.name);
			if (!sql) throw new BadRequest(`'${node.name}' is not a numeric property that can be used here.`);
			return sql;
		}
		case "unary":
			return `(-${compile(node.operand, resolve)})`;
		case "binary": {
			const left = compile(node.left, resolve);
			const right = compile(node.right, resolve);
			return node.op === "/" ? `(${left} / NULLIF(${right}, 0))` : `(${left} ${node.op} ${right})`;
		}
		case "call": {
			const args = node.args.map((arg) => compile(arg, resolve));
			// round(x, n) needs an integer scale, so the second argument is cast.
			if (node.fn === "round" && args.length === 2) return `round(${args[0]}, (${args[1]})::int)`;
			return `${node.fn}(${args.join(", ")})`;
		}
	}
}

/** Parse and compile against a set of allowed columns qualified by an alias. */
export function compileExpression(
	source: string,
	allowed: Map<string, string>,
): { sql: string; columns: string[] } {
	const tree = parse(source);
	return {
		sql: compile(tree, (name) => allowed.get(name) ?? allowed.get(name.toLowerCase()) ?? null),
		columns: [...new Set(columnsOf(tree))],
	};
}

/** A plain column name a derived property may be given. */
export function assertDerivedName(name: string): string {
	const trimmed = String(name ?? "").trim().toLowerCase();
	if (!/^[a-z][a-z0-9_]{0,40}$/.test(trimmed)) {
		throw new BadRequest(`'${name}' is not a usable property name: lowercase letters, digits and underscores, starting with a letter.`);
	}
	return quoteIdentifier(trimmed) && trimmed;
}
