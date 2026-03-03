<script lang="ts">
/**
 * Card component for a single approval item.
 * Shows action, description, risk badge, and approve/reject buttons.
 */
import type { ApprovalItem, ApprovalLevel } from "$lib/stores/approvals";

interface Props {
  item: ApprovalItem;
  onApprove: (id: string) => void;
  onReject: (id: string) => void;
}

let { item, onApprove, onReject }: Props = $props();

function levelColor(level: ApprovalLevel): string {
  const colors: Record<ApprovalLevel, string> = {
    safe: "var(--success)",
    needs_approval: "var(--warning)",
    dangerous: "var(--error)",
  };
  return colors[level];
}

function levelLabel(level: ApprovalLevel): string {
  const labels: Record<ApprovalLevel, string> = {
    safe: "Safe",
    needs_approval: "Needs Approval",
    dangerous: "Dangerous",
  };
  return labels[level];
}

function formatDate(timestamp: number): string {
  return new Date(timestamp).toLocaleDateString([], {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function timeRemaining(timeoutAt: number): string {
  const diff = timeoutAt - Date.now();
  if (diff <= 0) return "Expired";
  const minutes = Math.floor(diff / 60_000);
  if (minutes < 60) return `${minutes}m remaining`;
  const hours = Math.floor(minutes / 60);
  return `${hours}h ${minutes % 60}m remaining`;
}
</script>

<div
  class="approval-card"
  class:approved={item.status === "approved"}
  class:denied={item.status === "denied"}
>
  <div class="card-top">
    <div class="title-row">
      <h3 class="card-action">{item.action}</h3>
      <span
        class="level-badge"
        style="color: {levelColor(item.level)}; border-color: {levelColor(item.level)}"
      >
        {levelLabel(item.level)}
      </span>
    </div>
    <p class="card-description">{item.description}</p>
  </div>

  <div class="card-meta">
    <span class="meta-item">
      Channel: <strong>{item.channel}</strong>
    </span>
    <span class="meta-item">
      Escalation: <strong>{item.escalationLevel}</strong>
    </span>
    <span class="meta-item">
      {formatDate(item.createdAt)}
    </span>
    {#if item.status === "pending"}
      <span class="meta-item timeout">
        {timeRemaining(item.timeoutAt)}
      </span>
    {/if}
  </div>

  <div class="card-actions">
    {#if item.status === "pending"}
      <button class="approve-btn" onclick={() => onApprove(item.id)}>
        Approve
      </button>
      <button class="reject-btn" onclick={() => onReject(item.id)}>
        Reject
      </button>
    {:else}
      <span
        class="status-label"
        class:approved={item.status === "approved"}
        class:denied={item.status === "denied"}
      >
        {item.status === "approved" ? "Approved" : "Denied"}
        {#if item.respondedBy}
          <span class="responded-by">by {item.respondedBy}</span>
        {/if}
      </span>
    {/if}
  </div>
</div>

<style>
  .approval-card {
    padding: 14px 16px;
    border-radius: var(--radius);
    background: var(--bg-secondary);
    border: 1px solid var(--border);
    transition: opacity 0.2s;
  }

  .approval-card.approved {
    opacity: 0.6;
    border-left: 3px solid var(--success);
  }

  .approval-card.denied {
    opacity: 0.6;
    border-left: 3px solid var(--error);
  }

  .card-top {
    margin-bottom: 10px;
  }

  .title-row {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 10px;
    margin-bottom: 6px;
  }

  .card-action {
    font-size: 14px;
    font-weight: 600;
  }

  .level-badge {
    font-size: 11px;
    padding: 2px 8px;
    border: 1px solid;
    border-radius: var(--radius);
    font-weight: 600;
    white-space: nowrap;
  }

  .card-description {
    font-size: 13px;
    color: var(--text-secondary);
    line-height: 1.4;
  }

  .card-meta {
    display: flex;
    gap: 16px;
    font-size: 12px;
    color: var(--text-secondary);
    margin-bottom: 10px;
    flex-wrap: wrap;
  }

  .card-meta strong {
    color: var(--text-primary);
  }

  .timeout {
    color: var(--warning);
    font-weight: 500;
  }

  .card-actions {
    display: flex;
    gap: 8px;
    align-items: center;
  }

  .approve-btn {
    padding: 6px 16px;
    background: var(--success);
    color: white;
    border-radius: var(--radius);
    font-size: 13px;
    font-weight: 600;
  }

  .approve-btn:hover {
    filter: brightness(1.1);
  }

  .reject-btn {
    padding: 6px 16px;
    background: var(--bg-tertiary);
    color: var(--text-secondary);
    border-radius: var(--radius);
    font-size: 13px;
    font-weight: 600;
  }

  .reject-btn:hover {
    color: var(--error);
  }

  .status-label {
    font-size: 12px;
    font-weight: 600;
    text-transform: uppercase;
  }

  .status-label.approved {
    color: var(--success);
  }

  .status-label.denied {
    color: var(--error);
  }

  .responded-by {
    font-weight: 400;
    text-transform: none;
    color: var(--text-secondary);
    margin-left: 4px;
  }
</style>
