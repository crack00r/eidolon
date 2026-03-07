/**
 * Barrel export for the projects module.
 */

export { GitAnalyzer } from "./git-analyzer.ts";
export { ProjectJournal } from "./journal.ts";
export { ProjectManager } from "./manager.ts";
export type {
  CreateProjectInput,
  GitBranchInfo,
  GitCommit,
  Project,
  ProjectJournalEntry,
  ProjectStatus,
  UpdateProjectInput,
} from "./schema.ts";
export {
  CreateProjectInputSchema,
  GitBranchInfoSchema,
  GitCommitSchema,
  PROJECT_JOURNAL_TABLE_SQL,
  PROJECTS_TABLE_SQL,
  ProjectJournalEntrySchema,
  ProjectSchema,
  ProjectStatusSchema,
  UpdateProjectInputSchema,
} from "./schema.ts";
