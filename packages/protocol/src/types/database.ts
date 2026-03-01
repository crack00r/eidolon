/**
 * Database types for the 3-database split architecture.
 */

export type DatabaseName = "memory" | "operational" | "audit";

export interface Migration {
  readonly version: number;
  readonly name: string;
  readonly up: string;
  readonly down: string;
  readonly database: DatabaseName;
}
