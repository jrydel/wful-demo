import { expect, test } from "bun:test";
import { parseAvailability } from "./doctor";

test("every schedule format in the source dump parses into days and hours", () => {
  expect(parseAvailability("Mon-Fri 08:00-16:00")).toEqual({
    days: ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday"],
    from: "08:00",
    to: "16:00",
  });
  expect(parseAvailability("Mon-Sat 09:00-14:00")?.days).toHaveLength(6);
  expect(parseAvailability("Tue-Sat 08:30-16:30")).toMatchObject({
    days: ["Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"],
    from: "08:30",
  });
  expect(parseAvailability("Mon-Fri 10:00-18:00")?.to).toBe("18:00");
  expect(parseAvailability("Mon-Fri 09:00-17:00")?.from).toBe("09:00");
});

test("schedules in another shape are not guessed", () => {
  expect(parseAvailability("by appointment")).toBeUndefined();
  expect(parseAvailability("Fri-Mon 08:00-16:00")).toBeUndefined();
  expect(parseAvailability("Mon 08:00-16:00")).toBeUndefined();
});
