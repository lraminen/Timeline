import { describe, it, expect, beforeEach } from "vitest";
import { migrateFromTimelineJS, _resetIdCounter } from "../migrate.js";

// Reset auto-increment IDs between tests for deterministic assertions.
beforeEach(() => {
  _resetIdCounter();
});

// ---------------------------------------------------------------------------
// Sample TimelineJS v3 payloads
// ---------------------------------------------------------------------------
const sampleTimelineJS = {
  title: {
    text: {
      headline: "World War II",
      text: "A global conflict lasting from 1939 to 1945.",
    },
  },
  events: [
    {
      start_date: { year: 1939, month: 9, day: 1 },
      end_date: { year: 1945, month: 9, day: 2 },
      text: {
        headline: "Invasion of Poland",
        text: "Germany invades Poland, starting WWII in Europe.",
      },
      media: {
        url: "https://example.com/poland.jpg",
        caption: "German troops",
        credit: "Archive",
      },
    },
    {
      start_date: { year: 1941, month: 12, day: 7 },
      text: {
        headline: "Attack on Pearl Harbor",
        text: "Japan attacks the US naval base at Pearl Harbor.",
      },
    },
    {
      start_date: { year: 1944, month: 6, day: 6 },
      text: { headline: "D-Day" },
      group: "Western Front",
    },
  ],
};

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------
describe("migrateFromTimelineJS", () => {
  it("converts a full TimelineJS payload to Chronicle format", () => {
    const result = migrateFromTimelineJS(sampleTimelineJS);

    expect(result.id).toBe("imported-timelinejs");
    expect(result.title).toBe("World War II");
    expect(result.description).toBe(
      "A global conflict lasting from 1939 to 1945."
    );
    expect(result.events).toHaveLength(3);
    expect(result.eras).toEqual([]);
    expect(result.settings.layout).toBe("vertical");
  });

  it("converts dates correctly", () => {
    const result = migrateFromTimelineJS(sampleTimelineJS);
    const first = result.events[0];

    expect(first.date.start).toBe("1939-09-01");
    expect(first.date.end).toBe("1945-09-02");
  });

  it("converts media when present", () => {
    const result = migrateFromTimelineJS(sampleTimelineJS);
    const first = result.events[0];

    expect(first.media).toHaveLength(1);
    expect(first.media[0].type).toBe("image");
    expect(first.media[0].url).toBe("https://example.com/poland.jpg");
    expect(first.media[0].caption).toBe("German troops");
    expect(first.media[0].credit).toBe("Archive");
  });

  it("produces empty media array when event has no media", () => {
    const result = migrateFromTimelineJS(sampleTimelineJS);
    const second = result.events[1];

    expect(second.media).toEqual([]);
  });

  it("preserves group information", () => {
    const result = migrateFromTimelineJS(sampleTimelineJS);
    const dday = result.events[2];

    expect(dday.group).toBe("Western Front");
  });

  it("generates sequential IDs when unique_id is absent", () => {
    const result = migrateFromTimelineJS(sampleTimelineJS);
    expect(result.events[0].id).toBe("evt-1");
    expect(result.events[1].id).toBe("evt-2");
    expect(result.events[2].id).toBe("evt-3");
  });

  it("uses unique_id when provided", () => {
    const data = {
      events: [
        {
          unique_id: "custom-id",
          start_date: { year: 2020 },
          text: { headline: "Custom" },
        },
      ],
    };
    const result = migrateFromTimelineJS(data);
    expect(result.events[0].id).toBe("custom-id");
  });

  it("handles events with year-only dates", () => {
    const data = {
      events: [
        {
          start_date: { year: 1066 },
          text: { headline: "Battle of Hastings" },
        },
      ],
    };
    const result = migrateFromTimelineJS(data);
    expect(result.events[0].date.start).toBe("1066");
  });

  it("handles events with year-month dates", () => {
    const data = {
      events: [
        {
          start_date: { year: 1969, month: 7 },
          text: { headline: "Moon Landing" },
        },
      ],
    };
    const result = migrateFromTimelineJS(data);
    expect(result.events[0].date.start).toBe("1969-07");
  });

  it("falls back to default title when title slide is absent", () => {
    const data = {
      events: [
        {
          start_date: { year: 2024 },
          text: { headline: "Something" },
        },
      ],
    };
    const result = migrateFromTimelineJS(data);
    expect(result.title).toBe("Imported Timeline");
  });

  it("skips events that have no start_date", () => {
    const data = {
      events: [
        { text: { headline: "No date" } },
        { start_date: { year: 2024 }, text: { headline: "Has date" } },
      ],
    };
    const result = migrateFromTimelineJS(data);
    expect(result.events).toHaveLength(1);
    expect(result.events[0].title).toBe("Has date");
  });

  it("throws for non-object input", () => {
    expect(() => migrateFromTimelineJS(null)).toThrow();
    expect(() => migrateFromTimelineJS("string")).toThrow();
    expect(() => migrateFromTimelineJS(42)).toThrow();
  });
});
