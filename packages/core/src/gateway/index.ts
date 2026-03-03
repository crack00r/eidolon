// Gateway -- WebSocket server for client communication via JSON-RPC 2.0

export { certExists, generateSelfSignedCert } from "./cert-manager.ts";
export { handleOpenAIRequest, type OpenAICompatDeps } from "./openai-compat.ts";
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
} from "./protocol.ts";
export { AuthRateLimiter, DEFAULT_RATE_LIMIT_CONFIG, type RateLimitConfig } from "./rate-limiter.ts";
export { constantTimeCompare, GatewayServer, type MethodHandler } from "./server.ts";
export {
  extractWebhookResult,
  handleWebhookRequest,
  type WebhookDeps,
  type WebhookPayload,
  type WebhookResult,
} from "./webhook.ts";
