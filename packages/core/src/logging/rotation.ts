/**
 * Log file rotation by size.
 *
 * Rotates log files when they exceed a configurable size limit.
 * Files are numbered: current -> .1 -> .2 -> ... -> .maxFiles (deleted).
 */

import { existsSync, renameSync, statSync, unlinkSync } from "node:fs";
import { appendFile } from "node:fs/promises";
import { join } from "node:path";

export interface RotationConfig {
  readonly maxSizeMb: number;
  readonly maxFiles: number;
  readonly directory: string;
  readonly filename: string;
}

export class LogRotator {
  private readonly currentPath: string;

  constructor(private readonly config: RotationConfig) {
    this.currentPath = join(config.directory, config.filename);
  }

  /** Write a line to the log file, rotating if needed. */
  async writeLine(line: string): Promise<void> {
    this.checkRotation();
    await appendFile(this.currentPath, `${line}\n`, "utf-8");
  }

  /**
   * Check if the current log file exceeds the size limit and rotate if so.
   * SEC-L2: Wrapped in try/catch to handle TOCTOU race where the file
   * may be deleted or moved between existsSync() and statSync().
   */
  private checkRotation(): void {
    try {
      if (!existsSync(this.currentPath)) return;

      const stats = statSync(this.currentPath);
      const sizeMb = stats.size / (1024 * 1024);

      if (sizeMb < this.config.maxSizeMb) return;
      this.rotate();
    } catch {
      // File may have been deleted/moved between existsSync and statSync (TOCTOU).
      // This is non-fatal -- the next writeLine call will recreate the file.
    }
  }

  /** Shift existing rotated files and move the current file to .1 */
  private rotate(): void {
    // Shift existing rotated files: .N -> .N+1, deleting beyond maxFiles
    for (let i = this.config.maxFiles - 1; i >= 1; i--) {
      const from = `${this.currentPath}.${String(i)}`;
      const to = `${this.currentPath}.${String(i + 1)}`;

      if (!existsSync(from)) continue;

      if (i + 1 > this.config.maxFiles) {
        unlinkSync(from);
      } else {
        renameSync(from, to);
      }
    }

    // Current -> .1
    if (existsSync(this.currentPath)) {
      renameSync(this.currentPath, `${this.currentPath}.1`);
    }
  }
}
