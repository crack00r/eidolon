# Web Dashboard Verification Checklist (P2-12)

> Last updated: 2026-03-06. Platform: SvelteKit web dashboard served by Core daemon.

## Prerequisites

- [ ] Eidolon Core daemon is running
- [ ] Web dashboard is accessible at `http://localhost:8419/dashboard` (or configured gateway URL)
- [ ] Browser: Chrome, Firefox, Safari, or Edge (latest two versions)

## 1. Route Loading

All six routes must load without JavaScript errors (check browser console).

- [ ] `/dashboard` -- Main status overview
- [ ] `/dashboard/chat` -- Chat interface
- [ ] `/dashboard/memory` -- Memory browser
- [ ] `/dashboard/learning` -- Learning discoveries
- [ ] `/dashboard/settings` -- Configuration view
- [ ] `/dashboard/system` -- System health and metrics

## 2. Store Functionality

All six Svelte stores must initialize and update correctly.

- [ ] **Connection store**: Tracks WebSocket connection state (connected/disconnected/reconnecting)
- [ ] **Chat store**: Manages message history, streaming state, and send queue
- [ ] **Memory store**: Handles search queries, results, and pagination
- [ ] **Learning store**: Tracks discoveries, approvals, and filter state
- [ ] **System store**: Holds health status, metrics, and connected nodes
- [ ] **Settings store**: Persists user preferences (theme, notifications) in localStorage

## 3. Real-Time Updates via WebSocket

- [ ] Dashboard connects to Core WebSocket on page load
- [ ] Connection indicator shows current status
- [ ] Status overview updates in real-time (no manual refresh needed):
  - [ ] Daemon phase (idle/perceiving/evaluating/acting)
  - [ ] Active session count
  - [ ] Memory count
  - [ ] Pending approvals
  - [ ] Connected nodes
- [ ] Chat messages stream in real-time
- [ ] Learning discoveries appear as they are found
- [ ] System metrics update periodically (every 5-10 seconds)
- [ ] Reconnection happens automatically after disconnect
- [ ] Stale data indicator shows if WebSocket has been disconnected for >30s

## 4. Responsive Layout

- [ ] Desktop (1920x1080): full layout with sidebar navigation
- [ ] Laptop (1366x768): layout compresses gracefully, no horizontal scroll
- [ ] Tablet (768x1024): sidebar collapses to hamburger menu
- [ ] Mobile (375x667): single-column layout, all content accessible
- [ ] Text remains readable at all breakpoints (no truncation of critical info)
- [ ] Tables scroll horizontally on small screens (not break layout)
- [ ] Modals/dialogs are centered and fit within viewport

## 5. Dashboard Overview Page

- [ ] Daemon status badge (running/stopped/degraded)
- [ ] Uptime display
- [ ] Current loop phase
- [ ] Memory count with link to memory browser
- [ ] Learning discovery count with link to learning page
- [ ] Pending approval count (highlighted if > 0)
- [ ] Connected nodes list with online/offline status
- [ ] Recent activity log (last 10 events)
- [ ] Token usage summary (today and this week)

## 6. Chat Page

- [ ] Message input and send
- [ ] Streaming response display
- [ ] Markdown rendering
- [ ] Message history scrollback
- [ ] Clear conversation button (with confirmation)

## 7. Memory Page

- [ ] Search input with debounced query (300ms)
- [ ] Results display with relevance scores
- [ ] Type filter dropdown (fact, preference, decision, etc.)
- [ ] Confidence indicator (color-coded)
- [ ] Date display in human-readable format
- [ ] Pagination or infinite scroll for large result sets

## 8. Learning Page

- [ ] Discovery list with status indicators
- [ ] Source type badges (Reddit, HN, GitHub, RSS)
- [ ] Relevance score display
- [ ] Approve/Reject buttons for pending items
- [ ] Status filter (new, evaluated, approved, rejected, implemented)
- [ ] Implementation branch links (for approved items)

## 9. System Page

- [ ] Health check results (pass/fail/warn for each check)
- [ ] Token usage chart or table (by period, by session type)
- [ ] Circuit breaker status (closed/open/half-open)
- [ ] GPU worker status (if configured)
- [ ] Event bus queue depth
- [ ] Database sizes (memory.db, operational.db, audit.db)

## 10. Browser Compatibility

- [ ] Chrome (latest): all features work
- [ ] Firefox (latest): all features work
- [ ] Safari (latest): WebSocket works, layout correct
- [ ] Edge (latest): all features work
- [ ] No console errors on any page (warnings are acceptable)
- [ ] No broken images or missing assets
