import { describe, expect, it } from "vitest";

import {
  DAY,
  dayOf,
  dayStart,
  daysFromWindow,
  daysOfExtent,
  plusDays,
  weekFrom,
  windowForFrom,
  windowForTo,
  windowFromDays,
} from "./dateWindow";

const MAY_25 = Date.UTC(2020, 4, 25);
/** The tutorial model's year: hourly, 2020-01-01 00:00 to 2020-12-31 23:00. */
const YEAR: [number, number] = [Date.UTC(2020, 0, 1), Date.UTC(2020, 11, 31, 23)];

describe("dateWindow", () => {
  it("reads a day as midnight UTC and writes it back", () => {
    expect(dayStart("2020-05-25")).toBe(MAY_25);
    expect(dayOf(MAY_25)).toBe("2020-05-25");
    // Not the local day: an instant just before midnight UTC is still that day.
    expect(dayOf(MAY_25 + DAY - 1)).toBe("2020-05-25");
  });

  it.each(["", "25/05/2020", "2020-5-25", "2020-02-30", "not a day"])(
    "refuses %j as a day",
    (text) => {
      expect(dayStart(text)).toBeNull();
      expect(plusDays(text, 1)).toBeNull();
    },
  );

  it("counts days across a month end and a leap day", () => {
    expect(plusDays("2020-05-28", 6)).toBe("2020-06-03");
    expect(plusDays("2020-02-27", 3)).toBe("2020-03-01");
    expect(plusDays("2020-05-25", -1)).toBe("2020-05-24");
  });

  it("a week from a day is that day and the six after it", () => {
    expect(weekFrom("2020-05-25")).toBe("2020-05-31");
  });

  describe("windowFromDays", () => {
    it("covers both days in full", () => {
      expect(windowFromDays("2020-05-25", "2020-05-29", YEAR)).toEqual({
        startValue: MAY_25,
        endValue: Date.UTC(2020, 4, 30),
      });
    });

    it("clips to the data, and is no window at all over the whole of it", () => {
      // The last day ends after the last hour the data has.
      expect(windowFromDays("2020-12-25", "2020-12-31", YEAR)).toEqual({
        startValue: Date.UTC(2020, 11, 25),
        endValue: YEAR[1],
      });
      expect(windowFromDays("2019-12-01", "2021-01-31", YEAR)).toBeNull();
      expect(windowFromDays("2020-01-01", "2020-12-31", YEAR)).toBeNull();
    });

    it("stands unclipped before the data has arrived", () => {
      expect(windowFromDays("2020-05-25", "2020-05-25", null)).toEqual({
        startValue: MAY_25,
        endValue: MAY_25 + DAY,
      });
    });

    it.each([
      ["a bad from", "nope", "2020-05-29"],
      ["a bad to", "2020-05-25", ""],
      ["to before from", "2020-05-29", "2020-05-25"],
    ])("is null for %s", (_, from, to) => {
      expect(windowFromDays(from, to, YEAR)).toBeNull();
    });
  });

  it("reads the days a window covers, ending on the last day shown", () => {
    expect(daysFromWindow({ startValue: MAY_25, endValue: Date.UTC(2020, 4, 30) })).toEqual({
      from: "2020-05-25",
      to: "2020-05-29",
    });
    // A slider left mid-day still names the days on screen.
    expect(daysFromWindow({ startValue: MAY_25 + 7 * 3_600_000, endValue: MAY_25 + DAY + 1 })).toEqual({
      from: "2020-05-25",
      to: "2020-05-26",
    });
    expect(daysFromWindow(null)).toBeNull();
  });

  it("names the first and last day of an extent", () => {
    expect(daysOfExtent(YEAR)).toEqual({ first: "2020-01-01", last: "2020-12-31" });
    expect(daysOfExtent(null)).toBeNull();
  });

  describe("the day boxes", () => {
    it("a from day asks for the week starting there", () => {
      expect(windowForFrom("2020-05-25", YEAR)).toEqual({
        window: { startValue: MAY_25, endValue: MAY_25 + 7 * DAY },
      });
    });

    it("holds the week within the data", () => {
      expect(windowForFrom("2020-12-29", YEAR)).toEqual({
        window: { startValue: Date.UTC(2020, 11, 29), endValue: YEAR[1] },
      });
    });

    it("a to day keeps the from on screen", () => {
      expect(windowForTo("2020-05-27", "2020-05-25", YEAR)).toEqual({
        window: { startValue: MAY_25, endValue: MAY_25 + 3 * DAY },
      });
    });

    it("a to day alone asks for the week ending there, held within the data", () => {
      expect(windowForTo("2020-05-31", null, YEAR)).toEqual({
        window: { startValue: MAY_25, endValue: MAY_25 + 7 * DAY },
      });
      expect(windowForTo("2020-01-03", undefined, YEAR)).toEqual({
        window: { startValue: YEAR[0], endValue: YEAR[0] + 3 * DAY },
      });
    });

    it("marks a to before the from rather than swapping them", () => {
      // Which day the reader meant to move is theirs to say.
      expect(windowForTo("2020-05-20", "2020-05-25", YEAR)).toEqual({ invalid: "to" });
    });

    it("leaves the window alone while a box is mid-edit", () => {
      // A date box reads as "" between segments and fires change on each, so
      // typing the first digit of a to used to empty from and the chart.
      expect(windowForFrom("", YEAR)).toBeNull();
      expect(windowForTo("", "2020-05-25", YEAR)).toBeNull();
    });

    it("stands unclipped before the catalogue has arrived", () => {
      expect(windowForFrom("2020-05-25", null)).toEqual({
        window: { startValue: MAY_25, endValue: MAY_25 + 7 * DAY },
      });
    });
  });
});
