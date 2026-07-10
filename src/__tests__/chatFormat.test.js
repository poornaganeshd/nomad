import { describe, it, expect } from "vitest";
import { renderChatHtml, parseTxRow, prettyDate } from "../chatFormat";

describe("prettyDate", () => {
  it("formats ISO dates as 'D Mon'", () => {
    expect(prettyDate("2026-06-14")).toBe("14 Jun");
    expect(prettyDate("2026-01-09")).toBe("9 Jan");
  });
  it("leaves non-ISO strings untouched", () => {
    expect(prettyDate("last month")).toBe("last month");
  });
});

describe("parseTxRow", () => {
  it("parses a pipe row: date|amount|category|wallet|note", () => {
    const r = parseTxRow("2026-06-14|1725|Rent & Bills|Bank|Room rent (recurring)");
    expect(r).toMatchObject({ date: "2026-06-14", amount: 1725 });
    expect(r.desc).toContain("Rent & Bills");
    expect(r.desc).toContain("Room rent");
  });
  it("infers column order (amount before date)", () => {
    const r = parseTxRow("1862 | 2026-06-14 | Other | Bank | Groceries");
    expect(r).toMatchObject({ date: "2026-06-14", amount: 1862 });
  });
  it("parses a '·'-separated bullet row and strips the bullet", () => {
    const r = parseTxRow("• 09 Jun · ₹700 · Food & Drinks · Snacks");
    expect(r.amount).toBe(700);
    expect(r.desc).toContain("Snacks");
  });
  it("captures an income sign", () => {
    const r = parseTxRow("2026-06-02 | +10000 | Salary | Bank | Received");
    expect(r.sign).toBe("+");
    expect(r.amount).toBe(10000);
  });
  it("returns null for ordinary prose", () => {
    expect(parseTxRow("Here are the transactions over ₹500:")).toBeNull();
    expect(parseTxRow("It cost ₹500 · nice")).toBeNull(); // only 1 separator, no date, <3 parts
  });
  it("handles decimals and thousands separators", () => {
    const r = parseTxRow("2026-06-23|530.72|Personal Care|Bank|adapalene gel");
    expect(r.amount).toBeCloseTo(530.72); // parse keeps raw value; render rounds
    const r2 = parseTxRow("2026-06-23|1,24,500|Other|Bank|big");
    expect(r2.amount).toBe(124500);
  });
});

describe("renderChatHtml", () => {
  it("escapes HTML in model output", () => {
    const html = renderChatHtml("<script>alert(1)</script>");
    expect(html).not.toContain("<script>");
    expect(html).toContain("&lt;script&gt;");
  });
  it("renders **bold**", () => {
    expect(renderChatHtml("Total is **₹1,000**")).toContain("<strong>₹1,000</strong>");
  });
  it("groups consecutive transaction rows into one card", () => {
    const html = renderChatHtml(
      "2026-06-14|1725|Rent|Bank|rent\n2026-06-14|3800|Other|Bank|stove",
    );
    expect((html.match(/nmd-txs/g) || []).length).toBe(1);
    expect((html.match(/nmd-tx"/g) || []).length).toBe(2);
  });
  it("formats amounts with Indian grouping and a ₹", () => {
    const html = renderChatHtml("2026-06-14|124500|Other|Bank|big");
    expect(html).toContain("₹1,24,500");
  });
  it("renders bullets and section labels distinctly", () => {
    const html = renderChatHtml("Summary:\n- first point\n- second point");
    expect(html).toContain("nmd-h");
    expect((html.match(/nmd-li/g) || []).length).toBe(2);
  });
  it("keeps plain prose as paragraphs", () => {
    const html = renderChatHtml("You spent a lot this month.");
    expect(html).toContain("nmd-p");
  });
});
