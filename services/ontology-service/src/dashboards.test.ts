/**
 * Tests for slugify, which became user-facing when dashboards gained custom
 * names: the slug is the URL, so a title someone typed has to survive into
 * something readable and unique.
 */

import { describe, expect, it } from "vitest";
import { slugify } from "./dashboards";

describe("slugify", () => {
	it("lowercases and joins words with hyphens", () => {
		expect(slugify("Control Tower")).toBe("control-tower");
		expect(slugify("Freight Spend & Margin")).toBe("freight-spend-margin");
	});

	it("keeps accented letters readable instead of dropping them", () => {
		// This is the regression that prompted the change: "Kraków" used to
		// slug to "krak-w", because every non-ASCII letter became a separator.
		expect(slugify("Kraków")).toBe("krakow");
		expect(slugify("Réseau Français")).toBe("reseau-francais");
		expect(slugify("Über Alles")).toBe("uber-alles");
		expect(slugify("Ãgædìŧ")).not.toContain("-");
	});

	it("names the letters that have no decomposition", () => {
		expect(slugify("Straße")).toBe("strasse");
		expect(slugify("Ørsted")).toBe("orsted");
		expect(slugify("Æther")).toBe("aether");
		expect(slugify("Łódź")).toBe("lodz");
	});

	it("collapses runs of punctuation into one separator", () => {
		expect(slugify("Control  Tower — Live   Ops")).toBe("control-tower-live-ops");
		expect(slugify("A///B")).toBe("a-b");
	});

	it("never starts or ends with a separator", () => {
		for (const title of ["  padded  ", "—leading", "trailing—", "!!!x!!!"]) {
			const slug = slugify(title);
			expect(slug.startsWith("-")).toBe(false);
			expect(slug.endsWith("-")).toBe(false);
		}
	});

	it("truncates without leaving a trailing separator", () => {
		const slug = slugify(`${"word ".repeat(40)}end`);
		expect(slug.length).toBeLessThanOrEqual(60);
		expect(slug.endsWith("-")).toBe(false);
	});

	it("falls back to a generated name when nothing survives", () => {
		// A title of pure punctuation or pure CJK leaves no ASCII behind, and a
		// dashboard still needs an addressable slug.
		for (const title of ["!!!", "———", "日本語"]) {
			expect(slugify(title)).toMatch(/^dashboard-\d+$/);
		}
	});

	it("produces a slug safe to put in a URL path", () => {
		for (const title of ["Kraków", "Straße/Ørsted", "A & B", "50% On-Time"]) {
			const slug = slugify(title);
			expect(slug).toMatch(/^[a-z0-9-]+$/);
			expect(encodeURIComponent(slug)).toBe(slug);
		}
	});
});
