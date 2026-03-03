<script lang="ts">
/**
 * Real-time scrolling event list, color-coded by priority.
 * Shows recent system events with timestamps and sources.
 */

interface EventItem {
  id: string;
  type: string;
  priority: "critical" | "high" | "normal" | "low";
  source: string;
  timestamp: number;
  description: string;
}

interface Props {
  events: EventItem[];
  title?: string;
  maxHeight?: number;
  emptyMessage?: string;
}

let {
  events,
  title = "Event Stream",
  maxHeight = 400,
  emptyMessage = "No events to display",
}: Props = $props();

function priorityColor(priority: EventItem["priority"]): string {
  switch (priority) {
    case "critical":
      return "var(--error)";
    case "high":
      return "var(--warning)";
    case "normal":
      return "var(--accent)";
    case "low":
      return "var(--text-secondary)";
  }
}

function priorityIcon(priority: EventItem["priority"]): string {
  switch (priority) {
    case "critical":
      return "!!";
    case "high":
      return "!";
    case "normal":
      return "-";
    case "low":
      return ".";
  }
}

function formatTime(timestamp: number): string {
  return new Date(timestamp).toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
}

function shortenType(type: string): string {
  // "user:message" -> "message", "system:health_check" -> "health_check"
  const parts = type.split(":");
  return parts.length > 1 ? (parts[1] ?? type) : type;
}
</script>

<div class="event-stream">
  {#if title}
    <h3 class="stream-title">{title}</h3>
  {/if}

  <div class="stream-list" style="max-height: {maxHeight}px">
    {#if events.length === 0}
      <div class="stream-empty">{emptyMessage}</div>
    {:else}
      {#each events as event (event.id)}
        <div class="stream-item" class:critical={event.priority === "critical"}>
          <span
            class="priority-icon"
            style="color: {priorityColor(event.priority)}"
            title={event.priority}
          >
            {priorityIcon(event.priority)}
          </span>
          <span class="event-time">{formatTime(event.timestamp)}</span>
          <span class="event-type">{shortenType(event.type)}</span>
          <span class="event-desc">{event.description}</span>
          <span class="event-source">{event.source}</span>
        </div>
      {/each}
    {/if}
  </div>
</div>

<style>
  .event-stream {
    background: var(--bg-secondary);
    border: 1px solid var(--border);
    border-radius: var(--radius);
    padding: 14px 16px;
    display: flex;
    flex-direction: column;
  }

  .stream-title {
    font-size: 13px;
    font-weight: 600;
    color: var(--text-secondary);
    text-transform: uppercase;
    letter-spacing: 0.5px;
    margin-bottom: 10px;
  }

  .stream-list {
    overflow-y: auto;
    display: flex;
    flex-direction: column;
    gap: 2px;
  }

  .stream-empty {
    color: var(--text-secondary);
    font-size: 13px;
    padding: 20px 0;
    text-align: center;
  }

  .stream-item {
    display: flex;
    align-items: baseline;
    gap: 8px;
    padding: 4px 6px;
    border-radius: 3px;
    font-size: 13px;
    transition: background-color 0.15s ease;
  }

  .stream-item:hover {
    background: var(--bg-tertiary);
  }

  .stream-item.critical {
    background: rgba(231, 76, 60, 0.08);
  }

  .priority-icon {
    width: 16px;
    text-align: center;
    flex-shrink: 0;
    font-weight: 700;
    font-variant-numeric: tabular-nums;
  }

  .event-time {
    font-size: 11px;
    color: var(--text-secondary);
    flex-shrink: 0;
    font-variant-numeric: tabular-nums;
    min-width: 70px;
  }

  .event-type {
    font-size: 11px;
    color: var(--accent);
    flex-shrink: 0;
    min-width: 80px;
    font-weight: 500;
  }

  .event-desc {
    color: var(--text-primary);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
    flex: 1;
  }

  .event-source {
    font-size: 11px;
    color: var(--text-secondary);
    flex-shrink: 0;
    text-align: right;
    min-width: 60px;
  }
</style>
