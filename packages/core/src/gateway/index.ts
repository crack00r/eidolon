// Gateway -- WebSocket server for client communication via JSON-RPC 2.0

export {
  createJsonRpcError,
  createJsonRpcResponse,
  createPushEvent,
  JSON_RPC_INTERNAL_ERROR,
  JSON_RPC_INVALID_PARAMS,
  JSON_RPC_INVALID_REQUEST,
  JSON_RPC_METHOD_NOT_FOUND,
  JSON_RPC_PARSE_ERROR,
  parseJsonRpcRequest,
  validateMethod,
} from "./protocol.js";
export { GatewayServer, type MethodHandler } from "./server.js";
