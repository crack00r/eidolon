# Self-Learning Engine

## What Self-Learning Means

Self-learning in Eidolon is the ability to autonomously:

1. **Discover** interesting and relevant content from the web
2. **Evaluate** whether that content is useful
3. **Integrate** the knowledge into memory
4. **Implement** actionable improvements to its own codebase or configuration
5. **Report** what was learned and changed

This is NOT:
- Manually installing skills (like OpenClaw's ClawHub)
- The model "writing to HEARTBEAT.md" (like OpenClaw's memory)
- Fine-tuning or retraining (we use Claude as-is)

## Architecture

```
┌──────────────────────────────────────────────────────────┐
│               SELF-LEARNING PIPELINE                      │
│                                                           │
│  ┌─────────────────────────────────────────────────────┐ │
│  │ 1. DISCOVERY                                        │ │
│  │    Runs during idle phases of the Cognitive Loop      │ │
│  │    Sources: Reddit, HN, GitHub, RSS, configured URLs  │ │
│  └────────────────────────┬────────────────────────────┘ │
│                           ▼                               │
│  ┌─────────────────────────────────────────────────────┐ │
│  │ 2. RELEVANCE FILTER                                 │ │
│  │    Claude evaluates: Is this relevant?               │ │
│  │    Score: 0-100. Threshold: configurable (default 60) │ │
│  └────────────────────────┬────────────────────────────┘ │
│                           ▼                               │
│  ┌─────────────────────────────────────────────────────┐ │
│  │ 3. SAFETY CLASSIFICATION                            │ │
│  │    SAFE: Store as knowledge                          │ │
│  │    NEEDS_APPROVAL: Notify user, wait for confirmation│ │
│  │    DANGEROUS: Block, log, alert                      │ │
│  └────────────────────────┬────────────────────────────┘ │
│                           ▼                               │
│  ┌─────────────────────────────────────────────────────┐ │
│  │ 4. INTEGRATION                                      │ │
│  │    Knowledge → Memory (Long-Term)                    │ │
│  │    Actionable → Implementation Pipeline              │ │
│  └────────────────────────┬────────────────────────────┘ │
│                           ▼                               │
│  ┌─────────────────────────────────────────────────────┐ │
│  │ 5. IMPLEMENTATION (if actionable)                   │ │
│  │    Branch → Code → Test → Report                    │ │
│  └────────────────────────┬────────────────────────────┘ │
│                           ▼                               │
│  ┌─────────────────────────────────────────────────────┐ │
│  │ 6. REPORTING                                        │ │
│  │    Learning Journal + User notification              │ │
│  └─────────────────────────────────────────────────────┘ │
└──────────────────────────────────────────────────────────┘
```

## Discovery Pipeline

### Supported Sources

| Source | Method | Content Type |
|---|---|---|
| **Reddit** | API (read-only) or Playwright | Posts + top comments from configured subreddits |
| **Hacker News** | Firebase API | Stories above score threshold |
| **GitHub Trending** | Web scraping via Playwright | Repositories in configured languages/topics |
| **RSS Feeds** | Standard RSS/Atom parser | Articles from configured feeds |
| **Custom URLs** | Playwright | Any web page, scraped on schedule |

### Discovery Scheduling

Discovery doesn't use cron. It runs opportunistically during idle phases of the Cognitive Loop.

```typescript
class DiscoveryEngine {
  private sources: Source[];
  private lastCrawlPerSource: Map<string, Date>;

  async shouldDiscover(): boolean {
    // Check if any source is due for a crawl
    for (const source of this.sources) {
      const lastCrawl = this.lastCrawlPerSource.get(source.id);
      if (!lastCrawl || Date.now() - lastCrawl.getTime() > source.intervalMs) {
        return true;
      }
    }
    return false;
  }

  async discover(): Promise<Discovery[]> {
    const results: Discovery[] = [];

    for (const source of this.getDueSources()) {
      const items = await source.crawl();
      
      // Deduplicate against already-seen content
      const newItems = items.filter(item => !this.hasSeen(item.url));
      
      results.push(...newItems);
      this.lastCrawlPerSource.set(source.id, new Date());
    }

    return results;
  }
}
```

### Source Configuration

```jsonc
{
  "learning": {
    "enabled": true,
    "sources": [
      {
        "type": "reddit",
        "subreddits": ["selfhosted", "homelab", "ai_agents", "LocalLLaMA"],
        "sortBy": "hot",
        "limit": 25,
        "minScore": 50,
        "interval": "4h"
      },
      {
        "type": "hackernews",
        "minScore": 100,
        "limit": 30,
        "interval": "2h"
      },
      {
        "type": "github",
        "topics": ["ai-assistant", "personal-assistant", "self-hosted"],
        "languages": ["typescript", "python", "rust"],
        "interval": "6h"
      },
      {
        "type": "rss",
        "feeds": [
          "https://simonwillison.net/atom/everything/",
          "https://blog.anthropic.com/rss"
        ],
        "interval": "1h"
      }
    ]
  }
}
```

## Relevance Filter

Each discovered item is evaluated for relevance using Claude (cheap model).

### Prompt Template

```
You are evaluating content relevance for Eidolon, a personal AI assistant.

User interests (from memory):
{injected_user_interests}

System interests:
- Self-hosted AI/ML tools and techniques
- Personal assistant improvements
- Home automation and network management
- TypeScript/Python libraries and tools
- Security best practices

Content to evaluate:
Title: {title}
Source: {source}
Summary: {summary}

Rate relevance 0-100 and classify:
- INFO: Interesting knowledge, store in memory
- ACTIONABLE: Could improve Eidolon itself
- IRRELEVANT: Not useful

Respond as JSON:
{
  "score": 75,
  "classification": "INFO",
  "reason": "New sqlite-vec release with performance improvements",
  "tags": ["database", "vector-search", "performance"]
}
```

### Cost Control

- Use the cheapest available model (Haiku, Gemini Flash, or local)
- Batch evaluations (evaluate 10 items in one prompt)
- Skip items that match known-irrelevant patterns (ads, memes, duplicates)
- Daily token budget for relevance filtering: ~5000 tokens

## Safety Classification

Every actionable discovery goes through safety classification.

```
┌──────────────────────────────────────────────────┐
│           SAFETY CLASSIFICATION                   │
│                                                    │
│  ┌──────────┐  ┌────────────────┐  ┌───────────┐ │
│  │   SAFE   │  │ NEEDS_APPROVAL │  │ DANGEROUS │ │
│  │          │  │                │  │           │ │
│  │ Store    │  │ Notify user    │  │ Block     │ │
│  │ info in  │  │ Wait for       │  │ Log       │ │
│  │ memory   │  │ confirmation   │  │ Alert     │ │
│  │          │  │ before acting  │  │           │ │
│  │ Auto     │  │                │  │ Never     │ │
│  │          │  │ Timeout: 24h   │  │ execute   │ │
│  └──────────┘  └────────────────┘  └───────────┘ │
│                                                    │
│  Classification criteria:                          │
│  SAFE:                                            │
│  - Storing knowledge in memory                    │
│  - Reading public web content                     │
│  - Internal analysis and reflection               │
│                                                    │
│  NEEDS_APPROVAL:                                  │
│  - Modifying Eidolon's own code                   │
│  - Installing new dependencies                    │
│  - Changing configuration                         │
│  - Sending messages on user's behalf              │
│  - Creating files outside workspace               │
│                                                    │
│  DANGEROUS:                                        │
│  - System configuration changes                   │
│  - External API calls with side effects           │
│  - Deleting files or data                         │
│  - Network configuration changes                  │
│  - Authentication/credential changes              │
└──────────────────────────────────────────────────┘
```

## Implementation Pipeline

For actionable discoveries that pass safety classification:

### Step 1: Proposal

Create a structured proposal document:

```markdown
# Learning Proposal: sqlite-vec 0.2.0 Performance Update

## Source
Reddit r/selfhosted: "sqlite-vec 0.2.0 released with 3x faster search"
https://reddit.com/r/selfhosted/...

## Relevance
Score: 85/100
We use sqlite-vec for memory search. 3x performance improvement is significant.

## Proposed Action
Update sqlite-vec dependency from 0.1.x to 0.2.0

## Risk Assessment
Classification: NEEDS_APPROVAL
- Dependency update could break API compatibility
- Need to verify our usage patterns still work
- Low risk: well-maintained library with changelog

## Implementation Plan
1. Create branch `learning/sqlite-vec-0.2.0`
2. Update dependency
3. Run existing tests
4. Benchmark memory search performance
5. Report results

## Status: WAITING_APPROVAL
```

### Step 2: User Approval (if required)

Send notification to user via preferred channel:

```
[Learning] Found a potential improvement:
sqlite-vec 0.2.0 with 3x faster search.
Our memory search could benefit.

Reply 'approve' to implement, 'dismiss' to skip.
```

### Step 3: Implementation

If approved (or if classified as SAFE):

```typescript
class Implementer {
  async implement(proposal: Proposal): Promise<ImplementationResult> {
    // 1. Create branch
    await this.git.checkout(`learning/${proposal.slug}`);

    // 2. Use Claude Code to implement
    const session = await this.brain.startSession('learning', {
      workspace: this.learningWorkspace,
      systemPrompt: `
        You are implementing a learning proposal for Eidolon.
        Proposal: ${proposal.description}
        Plan: ${proposal.implementationPlan}
        
        Rules:
        - Make minimal, focused changes
        - Run tests after changes
        - Do not modify unrelated code
        - Document what you changed and why
      `
    });

    const result = await session.execute(proposal.implementationPlan);

    // 3. Run tests
    const testResult = await this.runTests();

    // 4. Report
    return {
      branch: `learning/${proposal.slug}`,
      changes: result.filesChanged,
      testsPassed: testResult.passed,
      summary: result.summary
    };
  }
}
```

### Step 4: Report

```
[Learning] Implementation complete:
Branch: learning/sqlite-vec-0.2.0
Changes: 2 files modified
Tests: All passed
Memory search is now 2.8x faster.

The branch is ready for review.
```

## Learning Journal

All learning activity is logged in `~/.eidolon/journal/YYYY-MM-DD.md`:

```markdown
# Learning Journal - 2026-03-01

## Discoveries (14 items scanned)
- [INFO] sqlite-vec 0.2.0 released (score: 85) → Stored in memory
- [INFO] New Playwright API for WebSocket interception (score: 72) → Stored
- [ACTIONABLE] Bun 1.2 native SQLite improvements (score: 91) → Proposal created
- [IRRELEVANT] 11 items below threshold

## Implementations
- sqlite-vec 0.2.0 update: APPROVED → IMPLEMENTED → Tests passed
- Bun 1.2 upgrade: WAITING_APPROVAL

## Knowledge Gained
- sqlite-vec 0.2.0 uses HNSW indexes for faster approximate search
- Bun 1.2 adds prepared statement caching for SQLite

## Token Usage
- Discovery crawling: 0 tokens (HTTP only)
- Relevance filtering: 1,200 tokens (Haiku)
- Implementation: 4,500 tokens (Opus)
- Total: 5,700 tokens
```

## CLI Commands

```bash
# View learning status
eidolon learning status

# List recent discoveries
eidolon learning discoveries --since 7d

# Approve a pending proposal
eidolon learning approve <proposal-id>

# Dismiss a proposal
eidolon learning dismiss <proposal-id>

# View learning journal
eidolon learning journal --date 2026-03-01

# Configure sources
eidolon learning sources list
eidolon learning sources add reddit --subreddit homeassistant

# Manually trigger a discovery cycle
eidolon learning discover --now

# View implementation branches
eidolon learning branches
```

## Configuration

```jsonc
{
  "learning": {
    "enabled": true,
    
    // Discovery sources (see above for full format)
    "sources": [...],
    
    // Relevance filtering
    "relevanceThreshold": 60,
    "relevanceModel": "haiku",     // Cheap model for filtering
    
    // Implementation
    "autoImplement": {
      "enabled": true,
      "requireApproval": true,     // For code changes
      "approvalTimeout": "24h",    // Auto-dismiss after timeout
      "safeBranch": true,          // Always use separate branch
      "runTests": true,            // Always run tests before reporting
      "maxDailyImplementations": 3 // Rate limit
    },
    
    // Budget
    "budget": {
      "discoveryTokensPerDay": 0,  // Discovery is HTTP, no tokens
      "filteringTokensPerDay": 5000,
      "implementationTokensPerDay": 20000
    },
    
    // Journal
    "journal": {
      "enabled": true,
      "path": "journal/",
      "retention": "90d"
    }
  }
}
```
