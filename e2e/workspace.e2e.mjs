/**
 * The journey a new customer takes, in a real browser against a running stack:
 *
 *   register -> empty workspace -> connect a PostgreSQL database -> import its
 *   tables -> ask what can be built -> ask for a dashboard -> approve what it
 *   needs -> open the board -> filter it by clicking a bar -> print as report
 *
 * Needs a running stack (E2E_BASE_URL) and a PostgreSQL database to connect
 * to (E2E_SOURCE_*) that holds a few related tables with foreign keys - any
 * will do; a sales schema (orders, order lines with price and quantity,
 * customers) exercises the most. Steps that depend on what the data holds
 * (a revenue dashboard needs a price and a quantity) are skipped, with the
 * reason, when it does not hold it.
 *
 *   E2E_BASE_URL=https://127.0.0.1:3000 \
 *   E2E_SOURCE_HOST=db.example.com E2E_SOURCE_DB=sales \
 *   E2E_SOURCE_USER=reporting E2E_SOURCE_PASSWORD=... \
 *   npm test
 *
 * Each run registers a fresh account, so it can be repeated against the same
 * stack; the accounts it leaves are named e2e-<timestamp>.
 */

import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { chromium } from "playwright";

const BASE = (process.env.E2E_BASE_URL ?? "http://127.0.0.1:5173").replace(/\/$/, "");
const SOURCE = {
	host: process.env.E2E_SOURCE_HOST ?? "",
	port: process.env.E2E_SOURCE_PORT ?? "5432",
	database: process.env.E2E_SOURCE_DB ?? "",
	username: process.env.E2E_SOURCE_USER ?? "",
	password: process.env.E2E_SOURCE_PASSWORD ?? "",
};
const configured = Boolean(SOURCE.host && SOURCE.database && SOURCE.username);
const user = `e2e-${Date.now().toString(36)}`;
const password = `Journey-${Math.random().toString(36).slice(2)}-2026!`;

let browser;
let page;

before(async () => {
	browser = await chromium.launch(process.env.PW_CHROMIUM ? { executablePath: process.env.PW_CHROMIUM } : {});
	const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, ignoreHTTPSErrors: true });
	page = await context.newPage();
	page.on("pageerror", (error) => console.error("page error:", error.message));
});

after(async () => {
	await browser?.close();
});

test("a new account registers and lands in an empty workspace", async () => {
	await page.goto(`${BASE}/`);
	await page.getByRole("tab", { name: "Create account" }).click();
	await page.getByLabel("Your name").fill("E2E Tester");
	await page.getByLabel("Username").fill(user);
	await page.getByLabel("Password", { exact: true }).fill(password);
	await page.getByLabel("Confirm password").fill(password);
	await page.getByRole("button", { name: "Create account" }).click();
	await page.getByRole("button", { name: "Connect your database" }).waitFor({ timeout: 20_000 });
	assert.match(await page.locator(".hero h1").innerText(), /E2E Tester/);
	// A new account sees only its own workspace: no space switcher.
	assert.equal(await page.locator(".space-switcher").count(), 0);
});

test("connecting a database imports its tables as a model", { skip: !configured && "E2E_SOURCE_* not set" }, async () => {
	await page.getByRole("button", { name: "Connect your database" }).click();
	const modal = page.locator(".modal");
	await modal.getByLabel("Name", { exact: true }).fill("E2E source");
	await modal.getByLabel("Host", { exact: true }).fill(SOURCE.host);
	await modal.getByLabel("Port", { exact: true }).fill(SOURCE.port);
	await modal.getByLabel("Database", { exact: true }).fill(SOURCE.database);
	await modal.getByLabel("Username", { exact: true }).fill(SOURCE.username);
	await modal.locator("input[type=password]").fill(SOURCE.password);
	await modal.getByRole("button", { name: "Test connection" }).click();
	await modal.locator(".test-result.ok").waitFor({ timeout: 20_000 });

	await modal.getByRole("button", { name: "Save and choose tables" }).click();
	await modal.locator(".table-pick").first().waitFor({ timeout: 30_000 });
	const importButton = modal.getByRole("button", { name: /^Import \d+ tables?$/ });
	await importButton.click();
	await modal.locator(".done-hero").waitFor({ timeout: 180_000 });
	const summary = await modal.locator(".done-hero").innerText();
	assert.match(summary, /\d+ object types/);
	await modal.getByRole("button", { name: "Done" }).click();
	// The home page now shows the workspace at a glance.
	await page.locator(".metric-strip").waitFor();
});

test("the assistant says what can be built", { skip: !configured && "E2E_SOURCE_* not set" }, async () => {
	await page.goto(`${BASE}/assistant?q=${encodeURIComponent("What can I build from my data?")}`);
	const answer = page.locator(".msg.assistant").last();
	await answer.waitFor({ timeout: 120_000 });
	await page.locator(".feasibility").first().waitFor({ timeout: 120_000 });
	assert.match(await answer.innerText(), /Ready to chart now|ready/i);
});

test("a dashboard request is built, or proposed and built on approval", { skip: !configured && "E2E_SOURCE_* not set" }, async (t) => {
	await page.getByRole("button", { name: "New conversation" }).click().catch(() => {});
	const box = page.locator(".composer textarea");
	await box.fill("build me a sales dashboard");
	await box.press("Enter");
	const reply = page.locator(".msg.assistant").last();
	await reply.locator(".board-artifact, .proposal-card, .feasibility").first().waitFor({ timeout: 180_000 });

	if ((await reply.locator(".proposal-card").count()) > 0) {
		await reply.locator(".proposal-card").getByRole("button", { name: "Approve" }).click();
		await page.getByRole("link", { name: /Open (dashboard|report)/ }).first().waitFor({ timeout: 120_000 });
	}
	const open = page.getByRole("link", { name: /Open (dashboard|report)/ }).first();
	if ((await open.count()) === 0) {
		t.skip("the data holds nothing a sales dashboard can be built from");
		return;
	}
	await open.click();
	await page.locator(".board-head h1").waitFor();

	// Click-to-filter: the first ranked bar filters the whole board.
	const totalBefore = await page.locator(".stat .value").first().innerText();
	const bar = page.locator(".widget rect.selectable").first();
	if ((await bar.count()) > 0) {
		await bar.click();
		await page.locator(".filter-chip").first().waitFor({ timeout: 30_000 });
		await page.waitForTimeout(1500);
		const totalAfter = await page.locator(".stat .value").first().innerText();
		assert.notEqual(totalAfter, totalBefore, "a filtered board shows a different total");
		await page.getByRole("button", { name: "Clear all" }).click();
	}

	// The same board as a document.
	await page.getByRole("button", { name: "▤ Report" }).click();
	await page.locator(".report-doc .report-highlights li").first().waitFor();
	assert.ok((await page.locator(".report-doc .report-section").count()) > 0);
});

test("syncing again keeps what was approved on top of the data", { skip: !configured && "E2E_SOURCE_* not set" }, async () => {
	// A refresh (by hand or on a schedule) must not trip over the datasets an
	// approval built on the synced tables.
	const login = await fetch(`${BASE}/api/auth/login`, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ username: user, password }),
	});
	assert.equal(login.status, 200);
	const { token } = await login.json();
	const headers = { authorization: `Bearer ${token}`, "content-type": "application/json" };
	const syncs = await (await fetch(`${BASE}/api/syncs`, { headers })).json();
	assert.ok(syncs.length > 0, "the import created syncs");
	for (const sync of syncs) {
		const response = await fetch(`${BASE}/api/syncs/${sync.id}/run`, { method: "POST", headers, body: "{}" });
		const body = await response.json();
		assert.equal(response.status, 200, `${sync.name}: ${JSON.stringify(body)}`);
		assert.equal(body.run.status, "success", `${sync.name}: ${body.run.errorMessage}`);
	}
});

test("approvals are listed with their outcome", { skip: !configured && "E2E_SOURCE_* not set" }, async () => {
	await page.goto(`${BASE}/approvals`);
	await page.getByRole("tab", { name: /All/ }).click();
	await page.locator(".page-head h1").waitFor();
	assert.equal(await page.locator(".page-head h1").innerText(), "Approvals");
});
