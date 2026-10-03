import { describe, expect, it } from "vitest";
import { turnsFromMessages } from "../ChatContext";
import { asClarification, chosenIn, composeAnswer, replyProse, toggleChoice } from "./ClarificationPanel";

describe("asClarification", () => {
	it("reads options given as objects or as plain strings", () => {
		const question = asClarification({
			kind: "clarification",
			question: "Which tables?",
			options: [{ label: "account", detail: "4 rows" }, "app_user"],
			multiple: true,
		});
		expect(question).toEqual({
			question: "Which tables?",
			options: [{ label: "account", detail: "4 rows" }, { label: "app_user" }],
			multiple: true,
			allowFreeText: true,
		});
	});

	// The page used to call .map on whatever arrived, and took the whole chat
	// down with it when an artifact carried no options.
	it("survives an artifact with no options, or with junk in them", () => {
		expect(asClarification({ kind: "clarification", question: "Go on?" })?.options).toEqual([]);
		expect(
			asClarification({ kind: "clarification", options: [null, 7, { label: "  " }, { detail: "no label" }, { label: "Yes" }] })
				?.options,
		).toEqual([{ label: "Yes" }]);
		expect(asClarification({ kind: "clarification", options: "account, app_user" })?.options).toEqual([]);
	});

	it("drops a repeated label, since it is one choice", () => {
		const question = asClarification({ kind: "clarification", options: ["a", { label: "a" }, "b"] });
		expect(question?.options.map((option) => option.label)).toEqual(["a", "b"]);
	});

	it("is single-choice unless there are several options and it says otherwise", () => {
		expect(asClarification({ kind: "clarification", options: ["a", "b"] })?.multiple).toBe(false);
		expect(asClarification({ kind: "clarification", options: ["a"], multiple: true })?.multiple).toBe(false);
		expect(asClarification({ kind: "clarification", options: ["a", "b"], multiple: true })?.multiple).toBe(true);
	});

	it("is nothing for any other artifact", () => {
		expect(asClarification({ kind: "chart" })).toBeNull();
		expect(asClarification(undefined)).toBeNull();
	});
});

describe("answering", () => {
	const question = asClarification({
		kind: "clarification",
		options: ["account", "app_user", "business_entity_contact"],
		multiple: true,
	})!;
	const single = asClarification({ kind: "clarification", options: ["Yes, create it", "No"] })!;

	it("keeps several choices in the order they were offered", () => {
		let chosen = toggleChoice(question, [], "business_entity_contact");
		chosen = toggleChoice(question, chosen, "account");
		expect(chosen).toEqual(["account", "business_entity_contact"]);
		expect(toggleChoice(question, chosen, "account")).toEqual(["business_entity_contact"]);
	});

	it("replaces the choice when only one is allowed", () => {
		expect(toggleChoice(single, ["No"], "Yes, create it")).toEqual(["Yes, create it"]);
		expect(toggleChoice(single, ["No"], "No")).toEqual([]);
	});

	it("sends the choices, then any note under them", () => {
		expect(composeAnswer(["account", "app_user"], "")).toBe("account, app_user");
		expect(composeAnswer(["account"], "  only active rows ")).toBe("account\n\nonly active rows");
		expect(composeAnswer([], "none of these")).toBe("none of these");
		expect(composeAnswer([], "  ")).toBe("");
	});

	it("reads the choices back out of the answer that was sent", () => {
		const sent = composeAnswer(["account", "business_entity_contact"], "only active rows");
		expect(chosenIn(sent, question.options)).toEqual(["account", "business_entity_contact"]);
		// A label with a comma in it is still one choice.
		expect(chosenIn("Yes, create it", single.options)).toEqual(["Yes, create it"]);
		expect(chosenIn("something else entirely", question.options)).toEqual([]);
	});
});

describe("replyProse", () => {
	const asked = asClarification({ kind: "clarification", question: "Model it now?", options: ["Yes", "No"] });

	it("keeps what was said before the question, and says the question once", () => {
		expect(replyProse("It is synced already.\n\nModel it now?", asked, false)).toBe("It is synced already.");
	});

	it("is empty when the reply was only the question", () => {
		expect(replyProse("Model it now?", asked, false)).toBe("");
	});

	it("leaves a reply written in prose as it was written", () => {
		const reply = "It is synced already. Would you like me to model it now?";
		expect(replyProse(reply, asked, true)).toBe(reply);
	});

	it("is the whole reply when there is no question, or the text does not end with it", () => {
		expect(replyProse("Built 3 object types.", null, false)).toBe("Built 3 object types.");
		expect(replyProse("Approved: Order to Customer.", asked, false)).toBe("Approved: Order to Customer.");
	});
});

describe("turnsFromMessages", () => {
	it("turns a stored conversation into the turns the page draws", () => {
		const turns = turnsFromMessages([
			{ role: "user", content: "how to create ingest_run dataset?", tool_calls: null, artifacts: null, latency_ms: null },
			{
				role: "assistant",
				content: "Would you like me to proceed?",
				tool_calls: [],
				artifacts: [{ kind: "clarification", question: "Proceed?", options: ["Yes", "No"], inferred: true }],
				latency_ms: 2900,
				model: "gpt-4.1",
				total_tokens: 5085,
				cost_usd: "0.010800",
			},
		]);
		expect(turns).toHaveLength(2);
		expect(turns[0]).toEqual({ role: "user", content: "how to create ingest_run dataset?" });
		expect(turns[1]?.artifacts?.[0]?.kind).toBe("clarification");
		expect(turns[1]?.meta).toMatchObject({ latencyMs: 2900, model: "gpt-4.1", tokens: 5085, costUsd: 0.0108, priced: true });
		// What the server does not keep per message is left unknown, not invented.
		expect(turns[1]?.meta?.rounds).toBeUndefined();
	});

	it("says a turn was unpriced rather than showing it as free", () => {
		const [turn] = turnsFromMessages([
			{ role: "assistant", content: "42", tool_calls: [], artifacts: [], latency_ms: 10, model: "planner", cost_usd: null },
		]);
		expect(turn?.meta?.priced).toBe(false);
		expect(turn?.meta?.costUsd).toBeUndefined();
	});

	it("leaves out the tool rows a conversation is stored with", () => {
		expect(turnsFromMessages([{ role: "tool", content: "{}", tool_calls: null, artifacts: null, latency_ms: null }])).toEqual([]);
	});
});
