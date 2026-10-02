import { describe, expect, it } from "vitest";
import { renderMarkdown } from "./common";

describe("renderMarkdown", () => {
	it("escapes HTML in the text it is given", () => {
		const html = renderMarkdown('<img src=x onerror="alert(1)"> & more');
		expect(html).not.toContain("<img");
		expect(html).toContain("&lt;img src=x onerror=&quot;alert(1)&quot;&gt; &amp; more");
	});

	it("links web pages and app paths but never script targets", () => {
		expect(renderMarkdown("[board](/dashboards/sales)")).toContain('<a href="/dashboards/sales">board</a>');
		expect(renderMarkdown("[docs](https://example.com)")).toContain('<a href="https://example.com">');
		for (const target of ["javascript:alert(1)", "data:text/html,x", "//evil.example"]) {
			expect(renderMarkdown(`[x](${target})`)).not.toContain("<a ");
		}
	});

	it("keeps code literal", () => {
		const html = renderMarkdown("revenue is `unit_price * quantity * (1 - discount)`");
		expect(html).toContain("<code>unit_price * quantity * (1 - discount)</code>");
		expect(html).not.toContain("<em>");
	});

	it("reads _italic_ only as a whole word, so snake_case survives", () => {
		expect(renderMarkdown("_Answered by the planner_")).toContain("<em>Answered by the planner</em>");
		expect(renderMarkdown("order_count and ship_country")).toContain("order_count and ship_country");
	});

	it("renders bold, lists and headings", () => {
		const html = renderMarkdown("## Ready\n\n- **Orders** per month\n- Freight\n\n1. one\n2. two");
		expect(html).toContain("<h3>Ready</h3>");
		expect(html).toContain("<ul><li><strong>Orders</strong> per month</li><li>Freight</li></ul>");
		expect(html).toContain("<ol><li>one</li><li>two</li></ol>");
	});

	it("renders a table from a header and separator row", () => {
		const html = renderMarkdown("| Country | Orders |\n|---|---:|\n| USA | 122 |\n| Germany | 122 |");
		expect(html).toContain("<thead><tr><th>Country</th><th>Orders</th></tr></thead>");
		expect(html).toContain("<tr><td>USA</td><td>122</td></tr>");
	});

	it("turns a mermaid fence into a diagram placeholder, other fences into code", () => {
		expect(renderMarkdown("```mermaid\ngraph LR\nA-->B\n```")).toContain(
			'<div class="mermaid-block" data-mermaid="graph LR\nA--&gt;B"></div>',
		);
		expect(renderMarkdown("```sql\nselect 1 < 2\n```")).toBe("<pre><code>select 1 &lt; 2</code></pre>");
	});

	it("makes resource directives clickable chips with escaped references", () => {
		const html = renderMarkdown('see :resource[objectType:Order"><script>]');
		expect(html).toContain('class="res-chip" data-resource-kind="objectType"');
		expect(html).not.toContain("<script>");
	});
});
