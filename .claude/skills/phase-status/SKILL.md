---
name: phase-status
description: Show current development phase progress for Eidolon project
context: fork
agent: eidolon-planner
allowed-tools: Read, Glob, Grep
---

# Phase Status Report

Analyze the current state of the Eidolon project and report progress against the roadmap.

1. Read `docs/ROADMAP.md` to understand the current phase and its deliverables
2. Check which deliverables exist by scanning the codebase:
   - Look for `packages/` directory structure
   - Check for `package.json` files in each package
   - Look for key source files mentioned in the roadmap
   - Check for test files
   - Check for CI workflow files in `.github/workflows/`
   - Check for systemd service file
3. For each deliverable, report status:
   - Done: file/feature exists and appears functional
   - Partial: started but incomplete
   - Not started: no evidence of implementation
4. Calculate overall completion percentage
5. Suggest the next 3 tasks to work on based on dependencies

Format the output as a clear status table with completion indicators.
