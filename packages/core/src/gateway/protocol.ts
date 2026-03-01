/**
 * JSON-RPC 2.0 message parsing, validation, and construction utilities
 * for the Gateway WebSocket server.
 */

import type { GatewayMethod, GatewayPushEvent, GatewayRequest, GatewayResponse, Result } from "@eidolon/protocol";
import { Err, Ok } from "@eidolon/protocol";

// ---------------------------------------------------------------------------
// Standard JSON-RPC 2.0 error codes
// ---------------------------------------------------------------------------

export const JSON_RPC_PARSE_ERROR = -32700;
export const JSON_RPC_INVALID_REQUEST = -32600;
export const JSON_RPC_METHOD_NOT_FOUND = -32601;
export const JSON_RPC_INVALID_PARAMS = -32602;
export const JSON_RPC_INTERNAL_ERROR = -32603;

// ---------------------------------------------------------------------------
// Valid gateway methods set (for O(1) lookup)
// ---------------------------------------------------------------------------

const VALID_METHODS: ReadonlySet<string> = new Set<GatewayMethod>([
  "chat.send",
  "chat.stream",
  "memory.search",
  "memory.delete",
  "session.list",
  "session.info",
  "learning.list",
  "learning.approve",
  "learning.reject",
  "system.status",
  "system.health",
  "voice.start",
  "voice.stop",
]);

// ---------------------------------------------------------------------------
// Parsing & validation
// ---------------------------------------------------------------------------

/**
 * Parse and validate an incoming JSON-RPC 2.0 request from raw WebSocket data.
 *
 * Returns a Result so callers can send a proper JSON-RPC error response
 * without crashing the server.
 */
export function parseJsonRpcRequest(data: string): Result<GatewayRequest, GatewayResponse> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(data);
  } catch {
    return Err(createJsonRpcError("null", JSON_RPC_PARSE_ERROR, "Parse error: invalid JSON"));
  }

  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return Err(createJsonRpcError("null", JSON_RPC_INVALID_REQUEST, "Invalid request: not an object"));
  }

  const obj = parsed as Record<string, unknown>;

  if (obj.jsonrpc !== "2.0") {
    return Err(
      createJsonRpcError(
        typeof obj.id === "string" ? obj.id : "null",
        JSON_RPC_INVALID_REQUEST,
        'Invalid request: missing or wrong "jsonrpc" field',
      ),
    );
  }

  if (typeof obj.id !== "string" || obj.id.length === 0 || obj.id.length > 256) {
    return Err(createJsonRpcError("null", JSON_RPC_INVALID_REQUEST, "Invalid id field"));
  }

  if (typeof obj.method !== "string" || obj.method.length === 0 || obj.method.length > 256) {
    return Err(createJsonRpcError(obj.id, JSON_RPC_INVALID_REQUEST, "Invalid method field"));
  }

  if (
    obj.params !== undefined &&
    (typeof obj.params !== "object" || obj.params === null || Array.isArray(obj.params))
  ) {
    return Err(createJsonRpcError(obj.id, JSON_RPC_INVALID_PARAMS, "Invalid params: must be an object"));
  }

  if (!validateMethod(obj.method)) {
    return Err(createJsonRpcError(obj.id, JSON_RPC_METHOD_NOT_FOUND, `Method not found: ${obj.method}`));
  }

  const request: GatewayRequest = {
    jsonrpc: "2.0",
    id: obj.id,
    method: obj.method as GatewayMethod,
    ...(obj.params !== undefined ? { params: obj.params as Record<string, unknown> } : {}),
  };

  return Ok(request);
}

/**
 * Check whether a method string is a valid GatewayMethod.
 */
export function validateMethod(method: string): method is GatewayMethod {
  return VALID_METHODS.has(method);
}

// ---------------------------------------------------------------------------
// Response construction
// ---------------------------------------------------------------------------

/**
 * Create a successful JSON-RPC 2.0 response.
 */
export function createJsonRpcResponse(id: string, result: unknown): GatewayResponse {
  return { jsonrpc: "2.0", id, result };
}

/**
 * Create a JSON-RPC 2.0 error response.
 */
export function createJsonRpcError(id: string, code: number, message: string, data?: unknown): GatewayResponse {
  return {
    jsonrpc: "2.0",
    id,
    error: {
      code,
      message,
      ...(data !== undefined ? { data } : {}),
    },
  };
}

/**
 * Create a JSON-RPC 2.0 push event (notification — no id field).
 */
export function createPushEvent(method: string, params: Record<string, unknown>): GatewayPushEvent {
  return { jsonrpc: "2.0", method, params };
}
