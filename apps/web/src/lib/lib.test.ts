import { describe, expect, it } from "vitest";
import { csvField, toCsv } from "./csv";
import {
  eventLabel,
  eventSummary,
  formatDate,
  formatDateTime,
  formatRelative,
  formatUsd,
} from "./format";

describe("formatUsd", () => {
  it("shows cents normally", () => {
    expect(formatUsd(0)).toBe("$0.00");
    expect(formatUsd(5.4)).toBe("$5.40");
    expect(formatUsd(1234.5)).toBe("$1,234.50");
  });
  it("keeps four decimals under a cent", () => {
    expect(formatUsd(0.002)).toBe("$0.0020");
    expect(formatUsd(0.00004)).toBe("$0.0000");
  });
});

describe("dates", () => {
  it("handles missing and bad values", () => {
    expect(formatDateTime(undefined)).toBe("");
    expect(formatDateTime("nope")).toBe("");
    expect(formatDate(undefined)).toBe("");
    expect(formatDate("nope")).toBe("");
    expect(formatRelative(undefined)).toBe("Never");
    expect(formatRelative("nope")).toBe("Never");
  });
  it("formats a bare UTC day as that day", () => {
    expect(formatDate("2026-11-07")).toMatch(/7/);
    expect(formatDateTime("2026-11-07T10:00:00Z")).toMatch(/2026/);
  });
  it("describes times relative to now", () => {
    const now = Date.parse("2026-11-07T12:00:00Z");
    expect(formatRelative("2026-11-07T11:59:30Z", now)).toMatch(/second|now/);
    expect(formatRelative("2026-11-07T11:30:00Z", now)).toMatch(
      /30 minutes ago/,
    );
    expect(formatRelative("2026-11-07T09:00:00Z", now)).toMatch(/3 hours ago/);
    expect(formatRelative("2026-11-04T12:00:00Z", now)).toMatch(/3 days ago/);
  });
});

describe("events", () => {
  it("labels known and unknown events", () => {
    expect(eventLabel("agent.paused")).toBe("Agent stopped");
    expect(eventLabel("thing.happened_now")).toBe("thing happened now");
  });
  it("summarises simple details only", () => {
    expect(eventSummary(undefined)).toBe("");
    expect(
      eventSummary({
        reason: "budget",
        abortedRequests: 2,
        nested: { a: 1 },
        none: null,
      }),
    ).toBe("reason: budget, aborted requests: 2");
  });
});

describe("csv", () => {
  it("quotes fields that need it", () => {
    expect(csvField("plain")).toBe("plain");
    expect(csvField('say "hi", ok')).toBe('"say ""hi"", ok"');
  });
  it("neutralises spreadsheet formulas", () => {
    expect(csvField("=HYPERLINK()")).toBe(`"'=HYPERLINK()"`);
  });
  it("joins rows with CRLF", () => {
    expect(toCsv(["a", "b"], [["1", "2"]])).toBe("a,b\r\n1,2");
  });
});
