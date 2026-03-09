/**
 * Cron validation and timezone-aware scheduling utilities.
 *
 * Extracted from scheduler.ts to keep file sizes manageable.
 */

// ---------------------------------------------------------------------------
// Cron validation
// ---------------------------------------------------------------------------

/** Field ranges for cron-like time values. */
const CRON_FIELD_RANGES = {
  minute: { min: 0, max: 59 },
  hour: { min: 0, max: 23 },
  dayOfMonth: { min: 1, max: 31 },
  month: { min: 1, max: 12 },
  dayOfWeek: { min: 0, max: 7 }, // 0 and 7 both mean Sunday
} as const;

/**
 * Validate a cron expression string.
 *
 * Supported formats:
 * - `HH:MM`      -- daily at time (hours 0-23, minutes 0-59)
 * - `star/N`      -- every N minutes (N must be 1-59)
 * - `HH:MM:dow`  -- at time on day of week (dow 0-7)
 *
 * @returns null if valid, error message string if invalid.
 */
export function validateCronExpression(cron: string): string | null {
  // "HH:MM" format
  if (/^\d{2}:\d{2}$/.test(cron)) {
    const [hours, minutes] = cron.split(":").map(Number) as [number, number];
    if (hours < CRON_FIELD_RANGES.hour.min || hours > CRON_FIELD_RANGES.hour.max) {
      return `Invalid hour ${hours}: must be ${CRON_FIELD_RANGES.hour.min}-${CRON_FIELD_RANGES.hour.max}`;
    }
    if (minutes < CRON_FIELD_RANGES.minute.min || minutes > CRON_FIELD_RANGES.minute.max) {
      return `Invalid minute ${minutes}: must be ${CRON_FIELD_RANGES.minute.min}-${CRON_FIELD_RANGES.minute.max}`;
    }
    return null;
  }

  // "*/N" format
  if (/^\*\/\d+$/.test(cron)) {
    const interval = Number.parseInt(cron.slice(2), 10);
    if (interval < 1 || interval > 1440) {
      return `Invalid interval ${interval}: must be 1-1440`;
    }
    return null;
  }

  // "HH:MM:dow" format
  if (/^\d{2}:\d{2}:\d$/.test(cron)) {
    const parts = cron.split(":").map(Number) as [number, number, number];
    const [hours, minutes, dow] = parts;
    if (hours < CRON_FIELD_RANGES.hour.min || hours > CRON_FIELD_RANGES.hour.max) {
      return `Invalid hour ${hours}: must be ${CRON_FIELD_RANGES.hour.min}-${CRON_FIELD_RANGES.hour.max}`;
    }
    if (minutes < CRON_FIELD_RANGES.minute.min || minutes > CRON_FIELD_RANGES.minute.max) {
      return `Invalid minute ${minutes}: must be ${CRON_FIELD_RANGES.minute.min}-${CRON_FIELD_RANGES.minute.max}`;
    }
    if (dow < CRON_FIELD_RANGES.dayOfWeek.min || dow > CRON_FIELD_RANGES.dayOfWeek.max) {
      return `Invalid day of week ${dow}: must be ${CRON_FIELD_RANGES.dayOfWeek.min}-${CRON_FIELD_RANGES.dayOfWeek.max}`;
    }
    return null;
  }

  // "HH:MM:dow1-dow2" range format (e.g., "09:00:1-5" for weekdays)
  if (/^\d{2}:\d{2}:\d-\d$/.test(cron)) {
    const parts = cron.split(":").map((p) => Number.parseInt(p, 10));
    const hours = parts[0] as number;
    const minutes = parts[1] as number;
    if (hours < CRON_FIELD_RANGES.hour.min || hours > CRON_FIELD_RANGES.hour.max) {
      return `Invalid hour ${hours}: must be ${CRON_FIELD_RANGES.hour.min}-${CRON_FIELD_RANGES.hour.max}`;
    }
    if (minutes < CRON_FIELD_RANGES.minute.min || minutes > CRON_FIELD_RANGES.minute.max) {
      return `Invalid minute ${minutes}: must be ${CRON_FIELD_RANGES.minute.min}-${CRON_FIELD_RANGES.minute.max}`;
    }
    const dowPart = cron.slice(6); // e.g., "1-5"
    const [startDowStr, endDowStr] = dowPart.split("-");
    const startDow = Number.parseInt(startDowStr ?? "0", 10);
    const endDow = Number.parseInt(endDowStr ?? "0", 10);
    if (startDow > endDow) {
      return `Invalid day-of-week range ${startDow}-${endDow}: start must be <= end`;
    }
    if (startDow < CRON_FIELD_RANGES.dayOfWeek.min || endDow > CRON_FIELD_RANGES.dayOfWeek.max) {
      return `Invalid day-of-week range ${startDow}-${endDow}: must be within ${CRON_FIELD_RANGES.dayOfWeek.min}-${CRON_FIELD_RANGES.dayOfWeek.max}`;
    }
    return null;
  }

  return `Unrecognized cron format: "${cron}". Use "HH:MM", "*/N", "HH:MM:dow", or "HH:MM:dow1-dow2"`;
}

/**
 * Validate an IANA timezone identifier.
 * Returns null if valid, error message if invalid.
 */
export function validateTimezone(tz: string): string | null {
  try {
    // Use Intl.DateTimeFormat to validate -- throws on invalid timezone
    Intl.DateTimeFormat(undefined, { timeZone: tz });
    return null;
  } catch {
    return `Invalid timezone: "${tz}"`;
  }
}

// ---------------------------------------------------------------------------
// Timezone-aware scheduling helpers
// ---------------------------------------------------------------------------

/**
 * Get the current hour/minute/day-of-week in a specific timezone.
 * Falls back to local time if timezone is not provided.
 */
function getTimeInTimezone(epochMs: number, timezone?: string): { hours: number; minutes: number; dow: number } {
  if (!timezone) {
    const d = new Date(epochMs);
    return { hours: d.getHours(), minutes: d.getMinutes(), dow: d.getDay() };
  }

  const formatter = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    hour: "numeric",
    minute: "numeric",
    weekday: "short",
    hour12: false,
  });

  const parts = formatter.formatToParts(new Date(epochMs));
  const hourPart = parts.find((p) => p.type === "hour");
  const minutePart = parts.find((p) => p.type === "minute");
  const weekdayPart = parts.find((p) => p.type === "weekday");

  // Some locales with hour12:false return "24" instead of "00" for midnight
  const rawHours = hourPart ? Number.parseInt(hourPart.value, 10) : 0;
  const hours = rawHours === 24 ? 0 : rawHours;
  const minutes = minutePart ? Number.parseInt(minutePart.value, 10) : 0;

  const DAY_MAP: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
  const dow = weekdayPart ? (DAY_MAP[weekdayPart.value] ?? 0) : 0;

  return { hours, minutes, dow };
}

/**
 * Compute next occurrence of HH:MM in the given timezone.
 * Scans forward in 1-minute increments to find the exact match.
 * This avoids DST pitfalls from direct Date manipulation.
 */
export function computeNextTimeInTimezone(
  targetHours: number,
  targetMinutes: number,
  afterMs: number,
  timezone?: string,
): number {
  if (!timezone) {
    // Original local-time behavior
    const next = new Date(afterMs);
    next.setHours(targetHours, targetMinutes, 0, 0);
    if (next.getTime() <= afterMs) {
      next.setDate(next.getDate() + 1);
    }
    return next.getTime();
  }

  // Start from next full minute after `afterMs`
  let candidate = afterMs - (afterMs % 60_000) + 60_000;
  // Scan up to 48 hours (2880 minutes) to handle DST transitions
  const maxScan = candidate + 48 * 60 * 60_000;

  while (candidate < maxScan) {
    const { hours, minutes } = getTimeInTimezone(candidate, timezone);
    if (hours === targetHours && minutes === targetMinutes) {
      return candidate;
    }
    candidate += 60_000;
  }

  // Should not happen for valid inputs -- fallback to 24h from now
  return afterMs + 24 * 60 * 60_000;
}

/**
 * Compute next occurrence of HH:MM on a specific day of week in the given timezone.
 */
export function computeNextDowInTimezone(
  targetHours: number,
  targetMinutes: number,
  targetDow: number,
  afterMs: number,
  timezone?: string,
): number {
  if (!timezone) {
    // Original local-time behavior
    const next = new Date(afterMs);
    next.setHours(targetHours, targetMinutes, 0, 0);
    const currentDow = next.getDay();
    let daysAhead = targetDow - currentDow;
    if (daysAhead < 0 || (daysAhead === 0 && next.getTime() <= afterMs)) {
      daysAhead += 7;
    }
    next.setDate(next.getDate() + daysAhead);
    return next.getTime();
  }

  // Scan forward up to 8 days in 1-minute increments
  let candidate = afterMs - (afterMs % 60_000) + 60_000;
  const maxScan = candidate + 8 * 24 * 60 * 60_000;

  while (candidate < maxScan) {
    const { hours, minutes, dow } = getTimeInTimezone(candidate, timezone);
    if (dow === targetDow && hours === targetHours && minutes === targetMinutes) {
      return candidate;
    }
    candidate += 60_000;
  }

  // Fallback
  return afterMs + 7 * 24 * 60 * 60_000;
}
