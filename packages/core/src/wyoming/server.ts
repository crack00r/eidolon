/**
 * Wyoming TCP server -- accepts satellite connections and processes voice events.
 *
 * Listens on a configurable port, enforces satellite allowlists,
 * and delegates event handling to WyomingHandler.
 */

import type { Server, Socket } from "node:net";
import { createServer } from "node:net";
import type { EidolonError, Result } from "@eidolon/protocol";
import { createError, Err, ErrorCode, Ok } from "@eidolon/protocol";
import type { Logger } from "../logging/logger.ts";
import type { WyomingConfig } from "./config.ts";
import type { WyomingHandler } from "./handler.ts";
import { WyomingParser } from "./protocol.ts";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface SatelliteConnection {
  readonly socket: Socket;
  readonly parser: WyomingParser;
  readonly handler: WyomingHandler;
  readonly remoteAddress: string;
  readonly satelliteId: string;
}

export interface WyomingServerDeps {
  readonly config: WyomingConfig;
  readonly handlerFactory: (satelliteId: string) => WyomingHandler;
  readonly logger: Logger;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Maximum concurrent satellite connections. */
const MAX_CONNECTIONS = 32;

// ---------------------------------------------------------------------------
// WyomingServer
// ---------------------------------------------------------------------------

export class WyomingServer {
  private readonly config: WyomingConfig;
  private readonly handlerFactory: (satelliteId: string) => WyomingHandler;
  private readonly logger: Logger;
  private readonly connections: Map<string, SatelliteConnection> = new Map();
  private server: Server | null = null;

  constructor(deps: WyomingServerDeps) {
    this.config = deps.config;
    this.handlerFactory = deps.handlerFactory;
    this.logger = deps.logger.child("wyoming-server");
  }

  /** Start the TCP server. */
  async start(): Promise<Result<void, EidolonError>> {
    if (!this.config.enabled) {
      this.logger.info("start", "Wyoming server is disabled");
      return Ok(undefined);
    }

    if (this.server !== null) {
      return Err(createError(ErrorCode.WYOMING_PROTOCOL_ERROR, "Wyoming server is already running"));
    }

    return new Promise<Result<void, EidolonError>>((resolve) => {
      const tcpServer = createServer((socket) => {
        this.handleConnection(socket);
      });

      tcpServer.on("error", (err: Error) => {
        this.logger.error("server", "Wyoming TCP server error", err);
        if (this.server === null) {
          resolve(Err(createError(ErrorCode.WYOMING_PROTOCOL_ERROR, `Failed to start: ${err.message}`, err)));
        }
      });

      tcpServer.listen(this.config.port, () => {
        this.server = tcpServer;
        this.logger.info("start", `Wyoming server listening on port ${this.config.port}`);
        resolve(Ok(undefined));
      });
    });
  }

  /** Stop the TCP server and close all connections. */
  async stop(): Promise<void> {
    // Close all satellite connections (collect IDs first to avoid modifying Map while iterating)
    const ids = [...this.connections.keys()];
    for (const id of ids) {
      const conn = this.connections.get(id);
      if (conn) {
        conn.handler.reset();
        conn.socket.destroy();
      }
    }
    this.connections.clear();

    if (this.server !== null) {
      const srv = this.server;
      this.server = null;

      await new Promise<void>((resolve) => {
        srv.close(() => resolve());
      });

      this.logger.info("stop", "Wyoming server stopped");
    }
  }

  /** Get the number of active connections. */
  get connectionCount(): number {
    return this.connections.size;
  }

  /** Get the listening port (useful when bound to port 0 in tests). */
  get port(): number | null {
    if (this.server === null) return null;
    const addr = this.server.address();
    if (addr === null || typeof addr === "string") return null;
    return addr.port;
  }

  // -----------------------------------------------------------------------
  // Connection handling
  // -----------------------------------------------------------------------

  private handleConnection(socket: Socket): void {
    const remoteAddress = socket.remoteAddress ?? "unknown";
    const remotePort = socket.remotePort ?? 0;
    const connectionId = `${remoteAddress}:${remotePort}`;

    // Enforce connection limit
    if (this.connections.size >= MAX_CONNECTIONS) {
      this.logger.warn("connection", `Rejecting connection from ${connectionId}: max connections reached`);
      socket.destroy();
      return;
    }

    // Use connection ID as satellite ID (can be overridden by protocol events)
    const satelliteId = connectionId;

    // Check allowlist
    if (!this.isSatelliteAllowed(satelliteId, remoteAddress)) {
      this.logger.warn("connection", `Rejecting satellite: ${connectionId} (not in allowlist)`);
      socket.destroy();
      return;
    }

    const parser = new WyomingParser();
    const handler = this.handlerFactory(satelliteId);

    const conn: SatelliteConnection = {
      socket,
      parser,
      handler,
      remoteAddress,
      satelliteId,
    };

    this.connections.set(connectionId, conn);
    this.logger.info("connection", `Satellite connected: ${connectionId}`);

    socket.on("data", (data: Buffer) => {
      this.handleData(connectionId, conn, new Uint8Array(data)).catch((err: unknown) => {
        this.logger.error("handleData", `Unhandled error processing data from ${connectionId}`, err);
      });
    });

    socket.on("close", () => {
      handler.reset();
      this.connections.delete(connectionId);
      this.logger.info("connection", `Satellite disconnected: ${connectionId}`);
    });

    socket.on("error", (err: Error) => {
      this.logger.warn("connection", `Socket error from ${connectionId}: ${err.message}`);
      handler.reset();
      this.connections.delete(connectionId);
      if (!socket.destroyed) {
        socket.destroy();
      }
    });
  }

  private async handleData(connectionId: string, conn: SatelliteConnection, data: Uint8Array): Promise<void> {
    const feedResult = conn.parser.feed(data);
    if (!feedResult.ok) {
      this.logger.warn("handleData", `Protocol error from ${connectionId}: ${feedResult.error.message}`);
      conn.socket.destroy();
      this.connections.delete(connectionId);
      return;
    }

    const events = conn.parser.take();
    for (const event of events) {
      const result = await conn.handler.handleEvent(event, conn.satelliteId);
      if (!result.ok) {
        this.logger.warn("handleData", `Handler error: ${result.error.message}`, {
          connectionId,
          eventType: event.type,
        });
        continue;
      }

      // Write response events back to socket
      for (const responseData of result.value) {
        if (!conn.socket.destroyed) {
          conn.socket.write(responseData);
        }
      }
    }
  }

  private isSatelliteAllowed(_satelliteId: string, remoteAddress: string): boolean {
    // Empty allowlist means all satellites are allowed
    if (this.config.allowedSatellites.length === 0) {
      return true;
    }

    // Strip IPv4-mapped IPv6 prefix (e.g. "::ffff:192.168.1.1" -> "192.168.1.1")
    // to prevent allowlist bypass via IPv4-mapped IPv6 addresses.
    const normalizedAddress = remoteAddress.startsWith("::ffff:") ? remoteAddress.slice(7) : remoteAddress;

    // Extract IP only (strip port) to prevent allowlist bypass via port appending
    const ipOnly =
      normalizedAddress.includes(":") && !normalizedAddress.includes("[")
        ? normalizedAddress
        : (normalizedAddress.split(":")[0] ?? normalizedAddress);

    // Check if remote address IP is in the allowlist
    return this.config.allowedSatellites.some((allowed) => allowed === ipOnly || allowed === normalizedAddress);
  }
}
