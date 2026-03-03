<script lang="ts">
import { onMount, onDestroy } from "svelte";
import { clientLog } from "$lib/logger";
import { isConnected } from "$lib/stores/connection";
import {
  calendarEvents,
  calendarConflicts,
  isLoadingCalendar,
  calendarError,
  startCalendarRefresh,
  stopCalendarRefresh,
  fetchCalendarEvents,
  createCalendarEvent,
  type CalendarEvent,
  type CalendarConflict,
} from "$lib/stores/calendar";

type ViewMode = "week" | "day";

let viewMode: ViewMode = $state("week");
let currentDate: Date = $state(new Date());

// Quick-create form state
let showCreateForm = $state(false);
let newTitle = $state("");
let newDate = $state(formatInputDate(new Date()));
let newStartTime = $state("09:00");
let newEndTime = $state("10:00");
let newDescription = $state("");
let isCreating = $state(false);

// Computed values
const weekStart = $derived.by(() => {
  const d = new Date(currentDate);
  const day = d.getDay();
  const diff = day === 0 ? -6 : 1 - day; // Monday start
  d.setDate(d.getDate() + diff);
  d.setHours(0, 0, 0, 0);
  return d;
});

const weekEnd = $derived.by(() => {
  const d = new Date(weekStart);
  d.setDate(d.getDate() + 7);
  return d;
});

const weekDays = $derived.by(() => {
  const days: Date[] = [];
  for (let i = 0; i < 7; i++) {
    const d = new Date(weekStart);
    d.setDate(d.getDate() + i);
    days.push(d);
  }
  return days;
});

const dayStart = $derived.by(() => {
  const d = new Date(currentDate);
  d.setHours(0, 0, 0, 0);
  return d;
});

const dayEnd = $derived.by(() => {
  const d = new Date(dayStart);
  d.setDate(d.getDate() + 1);
  return d;
});

const headerLabel = $derived.by(() => {
  if (viewMode === "week") {
    const ws = weekStart;
    const we = new Date(weekEnd);
    we.setDate(we.getDate() - 1);
    const opts: Intl.DateTimeFormatOptions = { month: "short", day: "numeric" };
    return `${ws.toLocaleDateString(undefined, opts)} - ${we.toLocaleDateString(undefined, { ...opts, year: "numeric" })}`;
  }
  return currentDate.toLocaleDateString(undefined, {
    weekday: "long",
    month: "long",
    day: "numeric",
    year: "numeric",
  });
});

const conflictEventIds = $derived.by(() => {
  const ids = new Set<string>();
  for (const c of $calendarConflicts) {
    ids.add(c.eventA.id);
    ids.add(c.eventB.id);
  }
  return ids;
});

const hours = Array.from({ length: 24 }, (_, i) => i);

// Navigation
function navigate(direction: -1 | 0 | 1): void {
  if (direction === 0) {
    currentDate = new Date();
    return;
  }
  const d = new Date(currentDate);
  if (viewMode === "week") {
    d.setDate(d.getDate() + direction * 7);
  } else {
    d.setDate(d.getDate() + direction);
  }
  currentDate = d;
}

// Fetch events when view/date changes
$effect(() => {
  if (!$isConnected) return;
  const start = viewMode === "week" ? weekStart.getTime() : dayStart.getTime();
  const end = viewMode === "week" ? weekEnd.getTime() : dayEnd.getTime();
  fetchCalendarEvents(start, end);
});

function eventsForDay(day: Date, events: CalendarEvent[]): CalendarEvent[] {
  const s = new Date(day);
  s.setHours(0, 0, 0, 0);
  const e = new Date(s);
  e.setDate(e.getDate() + 1);
  return events.filter(
    (ev) => ev.startTime < e.getTime() && ev.endTime > s.getTime(),
  );
}

function eventTopPercent(event: CalendarEvent, day: Date): number {
  const dayMs = new Date(day).setHours(0, 0, 0, 0);
  const startOfDay = dayMs;
  const msInDay = 24 * 60 * 60 * 1000;
  const offset = Math.max(0, event.startTime - startOfDay);
  return (offset / msInDay) * 100;
}

function eventHeightPercent(event: CalendarEvent, day: Date): number {
  const dayMs = new Date(day).setHours(0, 0, 0, 0);
  const startOfDay = dayMs;
  const endOfDay = startOfDay + 24 * 60 * 60 * 1000;
  const clampedStart = Math.max(event.startTime, startOfDay);
  const clampedEnd = Math.min(event.endTime, endOfDay);
  const msInDay = 24 * 60 * 60 * 1000;
  const duration = clampedEnd - clampedStart;
  return Math.max(2, (duration / msInDay) * 100);
}

function formatTime(ts: number): string {
  return new Date(ts).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

function formatDayHeader(d: Date): string {
  return d.toLocaleDateString(undefined, { weekday: "short", day: "numeric" });
}

function isToday(d: Date): boolean {
  const today = new Date();
  return (
    d.getFullYear() === today.getFullYear() &&
    d.getMonth() === today.getMonth() &&
    d.getDate() === today.getDate()
  );
}

function formatInputDate(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

async function handleCreate(): Promise<void> {
  if (!newTitle.trim()) return;
  isCreating = true;
  try {
    const [sh, sm] = newStartTime.split(":").map(Number);
    const [eh, em] = newEndTime.split(":").map(Number);
    const dateObj = new Date(newDate);
    const startTime = new Date(dateObj.getFullYear(), dateObj.getMonth(), dateObj.getDate(), sh, sm).getTime();
    const endTime = new Date(dateObj.getFullYear(), dateObj.getMonth(), dateObj.getDate(), eh, em).getTime();

    await createCalendarEvent({
      title: newTitle.trim(),
      startTime,
      endTime,
      ...(newDescription.trim() ? { description: newDescription.trim() } : {}),
    });

    // Reset form
    newTitle = "";
    newDescription = "";
    showCreateForm = false;
  } catch (err) {
    clientLog("error", "calendar-page", "handleCreate failed", err);
  } finally {
    isCreating = false;
  }
}

onMount(() => {
  startCalendarRefresh();
});

onDestroy(() => {
  stopCalendarRefresh();
});
</script>

<div class="calendar-page">
  <header class="page-header">
    <div class="header-left">
      <h2>Calendar</h2>
    </div>
    <div class="header-controls">
      <div class="view-tabs">
        <button
          class="tab-btn"
          class:active={viewMode === "week"}
          onclick={() => (viewMode = "week")}
        >Week</button>
        <button
          class="tab-btn"
          class:active={viewMode === "day"}
          onclick={() => (viewMode = "day")}
        >Day</button>
      </div>
      <div class="nav-controls">
        <button class="nav-btn" onclick={() => navigate(-1)}>Prev</button>
        <button class="nav-btn today-btn" onclick={() => navigate(0)}>Today</button>
        <button class="nav-btn" onclick={() => navigate(1)}>Next</button>
      </div>
      <button
        class="create-btn"
        onclick={() => (showCreateForm = !showCreateForm)}
      >
        {showCreateForm ? "Cancel" : "+ New Event"}
      </button>
    </div>
  </header>

  <div class="date-label">{headerLabel}</div>

  {#if $calendarError}
    <div class="error-banner">{$calendarError}</div>
  {/if}

  <!-- Quick-create form -->
  {#if showCreateForm}
    <div class="create-form">
      <div class="form-row">
        <input
          type="text"
          class="form-input title-input"
          placeholder="Event title"
          bind:value={newTitle}
        />
      </div>
      <div class="form-row">
        <input type="date" class="form-input" bind:value={newDate} />
        <input type="time" class="form-input time-input" bind:value={newStartTime} />
        <span class="form-separator">-</span>
        <input type="time" class="form-input time-input" bind:value={newEndTime} />
      </div>
      <div class="form-row">
        <input
          type="text"
          class="form-input"
          placeholder="Description (optional)"
          bind:value={newDescription}
        />
        <button
          class="submit-btn"
          onclick={handleCreate}
          disabled={!newTitle.trim() || isCreating || !$isConnected}
        >
          {isCreating ? "Creating..." : "Create"}
        </button>
      </div>
    </div>
  {/if}

  {#if !$isConnected}
    <div class="empty-state">
      <p>Connect to the gateway to view calendar.</p>
    </div>
  {:else if $isLoadingCalendar && $calendarEvents.length === 0}
    <div class="empty-state">
      <p>Loading calendar events...</p>
    </div>
  {:else if viewMode === "week"}
    <!-- Week View -->
    <div class="week-view">
      <div class="week-header">
        <div class="time-gutter-header"></div>
        {#each weekDays as day}
          <div class="day-header" class:today={isToday(day)}>
            {formatDayHeader(day)}
          </div>
        {/each}
      </div>
      <div class="week-body">
        <div class="time-gutter">
          {#each hours as hour}
            <div class="time-label">{String(hour).padStart(2, "0")}:00</div>
          {/each}
        </div>
        {#each weekDays as day}
          <div class="day-column" class:today-col={isToday(day)}>
            {#each hours as _hour}
              <div class="hour-slot"></div>
            {/each}
            <div class="events-layer">
              {#each eventsForDay(day, $calendarEvents) as event (event.id)}
                <div
                  class="event-block"
                  class:conflict={conflictEventIds.has(event.id)}
                  style="top: {eventTopPercent(event, day)}%; height: {eventHeightPercent(event, day)}%;"
                  title="{event.title}{event.location ? ` @ ${event.location}` : ''}\n{formatTime(event.startTime)} - {formatTime(event.endTime)}"
                >
                  <span class="event-title">{event.title}</span>
                  <span class="event-time">{formatTime(event.startTime)}</span>
                </div>
              {/each}
            </div>
          </div>
        {/each}
      </div>
    </div>
  {:else}
    <!-- Day View -->
    <div class="day-view">
      <div class="day-timeline">
        {#each hours as hour}
          <div class="timeline-row">
            <div class="timeline-time">{String(hour).padStart(2, "0")}:00</div>
            <div class="timeline-slot"></div>
          </div>
        {/each}
        <div class="day-events-layer">
          {#each eventsForDay(currentDate, $calendarEvents) as event (event.id)}
            <div
              class="event-block day-event-block"
              class:conflict={conflictEventIds.has(event.id)}
              style="top: {eventTopPercent(event, currentDate)}%; height: {eventHeightPercent(event, currentDate)}%;"
            >
              <span class="event-title">{event.title}</span>
              <span class="event-time">
                {formatTime(event.startTime)} - {formatTime(event.endTime)}
              </span>
              {#if event.location}
                <span class="event-location">{event.location}</span>
              {/if}
              {#if event.description}
                <span class="event-desc">{event.description}</span>
              {/if}
            </div>
          {/each}
        </div>
      </div>
    </div>
  {/if}
</div>

<style>
  .calendar-page {
    display: flex;
    flex-direction: column;
    height: 100%;
  }

  .page-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 12px 20px;
    border-bottom: 1px solid var(--border);
    flex-wrap: wrap;
    gap: 8px;
  }

  .header-left {
    display: flex;
    align-items: center;
    gap: 10px;
  }

  .page-header h2 {
    font-size: 16px;
    font-weight: 600;
  }

  .header-controls {
    display: flex;
    gap: 8px;
    align-items: center;
    flex-wrap: wrap;
  }

  .view-tabs {
    display: flex;
    border: 1px solid var(--border);
    border-radius: var(--radius);
    overflow: hidden;
  }

  .tab-btn {
    padding: 6px 14px;
    background: var(--bg-tertiary);
    color: var(--text-secondary);
    font-size: 13px;
    border: none;
    transition: background-color 0.15s, color 0.15s;
  }

  .tab-btn:hover {
    color: var(--text-primary);
  }

  .tab-btn.active {
    background: var(--accent);
    color: white;
  }

  .nav-controls {
    display: flex;
    gap: 4px;
  }

  .nav-btn {
    padding: 6px 12px;
    background: var(--bg-tertiary);
    color: var(--text-secondary);
    border-radius: var(--radius);
    font-size: 13px;
  }

  .nav-btn:hover {
    color: var(--text-primary);
  }

  .today-btn {
    color: var(--accent);
  }

  .create-btn {
    padding: 6px 14px;
    background: var(--accent);
    color: white;
    border-radius: var(--radius);
    font-size: 13px;
    font-weight: 600;
    transition: background-color 0.15s;
  }

  .create-btn:hover {
    background: var(--accent-hover);
  }

  .date-label {
    padding: 8px 20px;
    font-size: 14px;
    font-weight: 600;
    color: var(--text-primary);
    border-bottom: 1px solid var(--border);
  }

  .error-banner {
    padding: 8px 20px;
    background: rgba(231, 76, 60, 0.15);
    color: var(--error);
    font-size: 13px;
  }

  .empty-state {
    display: flex;
    align-items: center;
    justify-content: center;
    height: 100%;
    color: var(--text-secondary);
    font-size: 14px;
  }

  /* Quick-create form */
  .create-form {
    padding: 12px 20px;
    background: var(--bg-secondary);
    border-bottom: 1px solid var(--border);
    display: flex;
    flex-direction: column;
    gap: 8px;
  }

  .form-row {
    display: flex;
    gap: 8px;
    align-items: center;
  }

  .form-input {
    padding: 6px 10px;
    background: var(--bg-primary);
    color: var(--text-primary);
    border: 1px solid var(--border);
    border-radius: var(--radius);
    font-size: 13px;
  }

  .form-input:focus {
    border-color: var(--accent);
  }

  .title-input {
    flex: 1;
  }

  .time-input {
    width: 100px;
  }

  .form-separator {
    color: var(--text-secondary);
    font-size: 13px;
  }

  .form-row:last-child .form-input {
    flex: 1;
  }

  .submit-btn {
    padding: 6px 16px;
    background: var(--accent);
    color: white;
    border-radius: var(--radius);
    font-size: 13px;
    font-weight: 600;
    white-space: nowrap;
  }

  .submit-btn:hover:not(:disabled) {
    background: var(--accent-hover);
  }

  .submit-btn:disabled {
    opacity: 0.4;
    cursor: default;
  }

  /* ---- Week View ---- */
  .week-view {
    flex: 1;
    overflow-y: auto;
    display: flex;
    flex-direction: column;
  }

  .week-header {
    display: flex;
    border-bottom: 1px solid var(--border);
    position: sticky;
    top: 0;
    background: var(--bg-secondary);
    z-index: 2;
  }

  .time-gutter-header {
    width: 60px;
    min-width: 60px;
    border-right: 1px solid var(--border);
  }

  .day-header {
    flex: 1;
    padding: 8px 4px;
    text-align: center;
    font-size: 12px;
    font-weight: 600;
    color: var(--text-secondary);
    border-right: 1px solid var(--border);
  }

  .day-header:last-child {
    border-right: none;
  }

  .day-header.today {
    color: var(--accent);
    background: rgba(233, 69, 96, 0.05);
  }

  .week-body {
    display: flex;
    flex: 1;
  }

  .time-gutter {
    width: 60px;
    min-width: 60px;
    border-right: 1px solid var(--border);
  }

  .time-label {
    height: 48px;
    padding: 2px 8px 0 0;
    text-align: right;
    font-size: 11px;
    color: var(--text-secondary);
    font-variant-numeric: tabular-nums;
  }

  .day-column {
    flex: 1;
    position: relative;
    border-right: 1px solid var(--border);
  }

  .day-column:last-child {
    border-right: none;
  }

  .today-col {
    background: rgba(233, 69, 96, 0.03);
  }

  .hour-slot {
    height: 48px;
    border-bottom: 1px solid var(--border);
  }

  .hour-slot:last-child {
    border-bottom: none;
  }

  .events-layer {
    position: absolute;
    inset: 0;
    pointer-events: none;
  }

  .event-block {
    position: absolute;
    left: 2px;
    right: 2px;
    background: var(--accent);
    color: white;
    border-radius: 3px;
    padding: 2px 4px;
    font-size: 11px;
    overflow: hidden;
    pointer-events: auto;
    cursor: default;
    display: flex;
    flex-direction: column;
    gap: 1px;
    min-height: 16px;
    transition: box-shadow 0.15s;
  }

  .event-block:hover {
    box-shadow: 0 0 0 1px var(--text-primary);
    z-index: 1;
  }

  .event-block.conflict {
    border: 2px solid var(--warning);
    box-shadow: 0 0 4px rgba(243, 156, 18, 0.4);
  }

  .event-title {
    font-weight: 600;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }

  .event-time {
    font-size: 10px;
    opacity: 0.85;
    white-space: nowrap;
  }

  .event-location {
    font-size: 10px;
    opacity: 0.75;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }

  .event-desc {
    font-size: 10px;
    opacity: 0.7;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }

  /* ---- Day View ---- */
  .day-view {
    flex: 1;
    overflow-y: auto;
    padding: 0 20px;
  }

  .day-timeline {
    position: relative;
  }

  .timeline-row {
    display: flex;
    height: 48px;
    border-bottom: 1px solid var(--border);
  }

  .timeline-time {
    width: 60px;
    min-width: 60px;
    padding: 2px 8px 0 0;
    text-align: right;
    font-size: 11px;
    color: var(--text-secondary);
    font-variant-numeric: tabular-nums;
  }

  .timeline-slot {
    flex: 1;
  }

  .day-events-layer {
    position: absolute;
    top: 0;
    left: 68px;
    right: 0;
    bottom: 0;
    pointer-events: none;
  }

  .day-event-block {
    left: 4px;
    right: 4px;
    padding: 4px 8px;
    font-size: 12px;
  }

  .day-event-block .event-title {
    font-size: 13px;
  }

  .day-event-block .event-time {
    font-size: 11px;
  }

  /* Responsive */
  @media (max-width: 700px) {
    .header-controls {
      width: 100%;
      justify-content: flex-start;
    }

    .time-gutter,
    .time-gutter-header {
      width: 44px;
      min-width: 44px;
    }

    .time-label,
    .timeline-time {
      font-size: 10px;
      padding-right: 4px;
    }
  }
</style>
