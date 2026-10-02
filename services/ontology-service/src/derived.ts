/**
 * Derived properties: arithmetic over the numeric properties of an object,
 * and comparisons of its numbers or dates.
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
 * and, for dates: days_between(from, to) - whole days from one date to the
 * other - sequence_of(key, date[, tiebreak]) - 1 for each key's earliest row
 * by that date, 2 for its next, and so on, so "is this the customer's first
 * order" is `(sequence_of(customer_id, order_date, order_id) = 1)` - and
 * comparisons (< <= > >= = <>) of two numbers or two dates, which give 1 when
 * true, 0 when false and NULL when either side is missing. So
 * "shipped on time" is `(shipped_date <= required_date) * 100`, and its average
 * is an on-time percentage.
 *
 * A name must be one of the numeric columns the caller is allowed to use, and
 * is emitted quoted and qualified by the table it belongs to. A number is
 * emitted as a numeric literal from its parsed value, never from the input
 * text. Division is wrapped in NULLIF(divisor, 0), so a zero divisor gives
 * NULL rather than failing the whole query.
 */

import { BadRequest, quoteIdentifier } from "./registry";

export type Comparison = "<" | "<=" | ">" | ">=" | "=" | "<>";

export type Node =
	| { kind: "number"; value: number }
	| { kind: "column"; name: string }
	| { kind: "unary"; operand: Node }
	| { kind: "binary"; op: "+" | "-" | "*" | "/"; left: Node; right: Node }
	| { kind: "compare"; op: Comparison; left: Node; right: Node }
	| { kind: "call"; fn: string; args: Node[] };

const FUNCTIONS: Record<string, { min: number; max: number }> = {
	round: { min: 1, max: 2 },
	abs: { min: 1, max: 1 },
	coalesce: { min: 2, max: 4 },
	greatest: { min: 2, max: 4 },
	least: { min: 2, max: 4 },
	nullif: { min: 2, max: 2 },
	days_between: { min: 2, max: 2 },
	sequence_of: { min: 2, max: 3 },
};

const MAX_LENGTH = 300;
const MAX_TOKENS = 80;

type Token =
	| { type: "number"; value: number }
	| { type: "name"; value: string }
	| { type: "op"; value: "+" | "-" | "*" | "/" }
	| { type: "cmp"; value: Comparison }
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
		const comparison = /^(<=|>=|<>|!=|==|<|>|=)/.exec(source.slice(i));
		if (comparison) {
			const op = comparison[0] === "!=" ? "<>" : comparison[0] === "==" ? "=" : (comparison[0] as Comparison);
			tokens.push({ type: "cmp", value: op });
			i += comparison[0].length;
			if (tokens.length > MAX_TOKENS) throw new BadRequest("That expression is too long.");
			continue;
		}
		if ("+-*/".includes(ch)) {
			tokens.push({ type: "op", value: ch as "+" | "-" | "*" | "/" });
		} else if (ch === "(" || ch === ")") {
			tokens.push({ type: "paren", value: ch });
		} else if (ch === ",") {
			tokens.push({ type: "comma" });
		} else {
			throw new BadRequest(
				`'${ch}' is not allowed in an expression. Use numbers, property names, + - * /, comparisons and parentheses.`,
			);
		}
		i += 1;
		if (tokens.length > MAX_TOKENS) throw new BadRequest("That expression is too long.");
	}
	return tokens;
}

/**
 * Recursive descent:
 *   comparison := expr (cmp expr)?
 *   expr := term (('+'|'-') term)*, term := factor (('*'|'/') factor)*
 * One comparison per level: `a < b < c` means nothing in SQL either.
 */
export function parse(source: string): Node {
	const tokens = tokenize(source);
	let pos = 0;
	const peek = () => tokens[pos];
	const take = () => tokens[pos++];

	const comparison = (): Node => {
		const left = expression();
		const t = peek();
		if (t?.type !== "cmp") return left;
		take();
		const right = expression();
		if (peek()?.type === "cmp") throw new BadRequest("Compare two values at a time; use parentheses to combine comparisons.");
		return { kind: "compare", op: t.value, left, right };
	};

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
			const inner = comparison();
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

	const tree = comparison();
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
		case "compare":
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
	return compileTyped(node, resolve, () => null).sql;
}

type Typed = { sql: string; type: "number" | "date" };

/** Compile with types: numbers take arithmetic, dates take comparison and days_between. */
export function compileTyped(
	node: Node,
	numeric: (name: string) => string | null,
	dates: (name: string) => string | null,
	keys: (name: string) => string | null = () => null,
): Typed {
	const number = (child: Node, what: string): string => {
		const typed = compileTyped(child, numeric, dates, keys);
		if (typed.type !== "number") throw new BadRequest(`${what} needs numbers; for dates use days_between(from, to) or a comparison.`);
		return typed.sql;
	};
	switch (node.kind) {
		case "number":
			if (!Number.isFinite(node.value)) throw new BadRequest("A number in the expression is not finite.");
			return { sql: `${node.value}::numeric`, type: "number" };
		case "column": {
			const sql = numeric(node.name);
			if (sql) return { sql, type: "number" };
			const date = dates(node.name);
			if (date) return { sql: date, type: "date" };
			throw new BadRequest(`'${node.name}' is not a numeric or date property that can be used here.`);
		}
		case "unary":
			return { sql: `(-${number(node.operand, "A minus sign")})`, type: "number" };
		case "binary": {
			const left = number(node.left, `'${node.op}'`);
			const right = number(node.right, `'${node.op}'`);
			return { sql: node.op === "/" ? `(${left} / NULLIF(${right}, 0))` : `(${left} ${node.op} ${right})`, type: "number" };
		}
		case "compare": {
			const left = compileTyped(node.left, numeric, dates, keys);
			const right = compileTyped(node.right, numeric, dates, keys);
			if (left.type !== right.type) throw new BadRequest("A comparison needs two numbers or two dates.");
			// Dates are compared as dates, so a timestamp and a date compare by day.
			const l = left.type === "date" ? `(${left.sql})::date` : left.sql;
			const r = right.type === "date" ? `(${right.sql})::date` : right.sql;
			return {
				sql: `(CASE WHEN ${l} IS NULL OR ${r} IS NULL THEN NULL WHEN ${l} ${node.op} ${r} THEN 1 ELSE 0 END)::numeric`,
				type: "number",
			};
		}
		case "call": {
			if (node.fn === "sequence_of") {
				// A window over every row, not a value of one row: which of its
				// key's rows this is, in date order. Ties break on the third
				// column, so the numbering never depends on how rows are read.
				const [key, date, tiebreak] = node.args;
				const named = (arg: Node | undefined, what: string): string => {
					const sql = arg?.kind === "column" ? keys(arg.name) ?? numeric(arg.name) ?? dates(arg.name) : null;
					if (!sql) throw new BadRequest(`sequence_of needs ${what} as a property name.`);
					return sql;
				};
				const ordered = compileTyped(date!, numeric, dates, keys);
				if (date!.kind !== "column" || ordered.type !== "date") throw new BadRequest("sequence_of orders by a date property.");
				const order = [ordered.sql, ...(tiebreak ? [named(tiebreak, "its tie-break")] : [])].join(", ");
				return { sql: `(row_number() OVER (PARTITION BY ${named(key, "the key it counts within")} ORDER BY ${order}))::numeric`, type: "number" };
			}
			if (node.fn === "days_between") {
				const [from, to] = node.args.map((arg) => compileTyped(arg, numeric, dates, keys));
				if (from!.type !== "date" || to!.type !== "date") throw new BadRequest("days_between takes two dates.");
				return { sql: `((${to!.sql})::date - (${from!.sql})::date)::numeric`, type: "number" };
			}
			const args = node.args.map((arg) => number(arg, `${node.fn}()`));
			// round(x, n) needs an integer scale, so the second argument is cast.
			if (node.fn === "round" && args.length === 2) return { sql: `round(${args[0]}, (${args[1]})::int)`, type: "number" };
			return { sql: `${node.fn}(${args.join(", ")})`, type: "number" };
		}
	}
}

/** Parse and compile against a set of allowed columns qualified by an alias. */
export function compileExpression(
	source: string,
	allowed: Map<string, string>,
	dateColumns: Map<string, string> = new Map(),
	keyColumns: Map<string, string> = new Map(),
): { sql: string; columns: string[] } {
	const tree = parse(source);
	const typed = compileTyped(
		tree,
		(name) => allowed.get(name) ?? allowed.get(name.toLowerCase()) ?? null,
		(name) => dateColumns.get(name) ?? dateColumns.get(name.toLowerCase()) ?? null,
		(name) => keyColumns.get(name) ?? keyColumns.get(name.toLowerCase()) ?? null,
	);
	if (typed.type !== "number") {
		throw new BadRequest("A derived property must be a number: compare dates, or use days_between(from, to).");
	}
	return { sql: typed.sql, columns: [...new Set(columnsOf(tree))] };
}

/** A plain column name a derived property may be given. */
export function assertDerivedName(name: string): string {
	const trimmed = String(name ?? "").trim().toLowerCase();
	if (!/^[a-z][a-z0-9_]{0,40}$/.test(trimmed)) {
		throw new BadRequest(`'${name}' is not a usable property name: lowercase letters, digits and underscores, starting with a letter.`);
	}
	return quoteIdentifier(trimmed) && trimmed;
}
