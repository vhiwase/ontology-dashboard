/**
 * interfacesOf — the read side of the ontology's interfaces.
 *
 * The pipeline emits InterfaceDefinitions with attribute refs and stamps
 * `implements` on entity types; this function resolves both back to named
 * properties and api names. Tested against a minimal fake registry so the
 * assertion is about the resolution, not about the database.
 */

import { describe, expect, it } from "vitest";
import { interfacesOf, type Registry } from "./registry";

function fakeRegistry(definition: Record<string, unknown>): Registry {
	return {
		definition,
		objectTypes: [
			{
				rid: "ri.object.main.location",
				apiName: "Location",
				properties: [
					{ rid: "attr-lat", apiName: "latitude", label: "Latitude" },
					{ rid: "attr-city", apiName: "city", label: "City" },
				],
			},
			{
				rid: "ri.object.main.carrier",
				apiName: "Carrier",
				properties: [{ rid: "attr-name", apiName: "entityName", label: "Entity Name" }],
			},
		],
	} as unknown as Registry;
}

describe("interfacesOf", () => {
	it("resolves attribute refs to property names and finds implementors", () => {
		const registry = fakeRegistry({
			interfaces: [
				{
					"@id": "tms:Geolocatable",
					"@type": "Interface",
					label: { en: "Geolocatable" },
					description: { en: "Anything that can be placed on a map." },
					requiredAttributes: [
						{ ref: "attr-lat", required: false },
						{ ref: "attr-city", required: false },
					],
				},
				{
					"@id": "tms:Party",
					"@type": "Interface",
					label: { en: "Party" },
					requiredAttributes: [{ ref: "attr-name", required: true }],
				},
			],
			entityTypes: [
				{
					"@id": "ri.object.main.location",
					implements: ["tms:Geolocatable"],
				},
				{
					"@id": "ri.object.main.carrier",
					implements: ["tms:Party", "tms:Geolocatable"],
				},
			],
		});

		const interfaces = interfacesOf(registry);
		expect(interfaces).toHaveLength(2);

		const geo = interfaces.find((i) => i.apiName === "Geolocatable")!;
		expect(geo.label).toBe("Geolocatable");
		expect(geo.description).toBe("Anything that can be placed on a map.");
		expect(geo.requiredAttributes.map((a) => a.apiName)).toEqual(["latitude", "city"]);
		expect(geo.implementors).toEqual(["Location", "Carrier"]);

		const party = interfaces.find((i) => i.apiName === "Party")!;
		expect(party.requiredAttributes[0]).toMatchObject({
			apiName: "entityName",
			label: "Entity Name",
			required: true,
		});
	});

	it("handles a definition with no interfaces and unresolvable refs honestly", () => {
		expect(interfacesOf(fakeRegistry({}))).toEqual([]);

		const [phantom] = interfacesOf(
			fakeRegistry({
				interfaces: [
					{ "@id": "tms:Ghost", label: { en: "Ghost" }, requiredAttributes: [{ ref: "attr-nope" }] },
				],
				entityTypes: [],
			}),
		);
		// An interface nothing implements is reported with an empty implementor
		// list and the raw ref, not silently dropped — the definition said it.
		expect(phantom.implementors).toEqual([]);
		expect(phantom.requiredAttributes[0].apiName).toBe("attr-nope");
	});
});
