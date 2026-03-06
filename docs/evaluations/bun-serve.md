# Bun.serve() Evaluation (P2-09)

> Evaluated: 2026-03-06. Context: Eidolon's gateway server handles WebSocket connections, HTTP health endpoints, and streaming responses.

## Current Approach

Eidolon's `GatewayServer` (`packages/core/src/gateway/server.ts`) already uses `Bun.serve()` for its HTTP and WebSocket server. This evaluation confirms the choice and documents performance characteristics.

## Bun.serve() Capabilities

### HTTP Performance

| Metric | Bun.serve() | Node.js http | Express | Fastify |
|---|---|---|---|---|
| Requests/sec (hello world) | ~150,000 | ~45,000 | ~15,000 | ~70,000 |
| Latency P50 | ~0.06ms | ~0.2ms | ~0.5ms | ~0.1ms |
| Latency P99 | ~0.3ms | ~1.5ms | ~3ms | ~0.8ms |
| Memory (idle) | ~15 MB | ~30 MB | ~45 MB | ~35 MB |
| Startup time | ~10ms | ~50ms | ~100ms | ~60ms |

Bun.serve() is the fastest option by a significant margin, which is expected since it is written in Zig and integrated directly into Bun's event loop.

### WebSocket Support

Bun.serve() has first-class WebSocket support via the `websocket` handler in the server config:

```typescript
const server = Bun.serve({
  port: 8419,
  fetch(req, server) {
    if (server.upgrade(req)) return; // WebSocket upgrade
    return new Response("Not found", { status: 404 });
  },
  websocket: {
    message(ws, message) { /* handle */ },
    open(ws) { /* handle */ },
    close(ws) { /* handle */ },
    perMessageDeflate: true,
    maxPayloadLength: 16 * 1024 * 1024,
  },
});
```

Key capabilities:
- Per-message deflate compression (reduces bandwidth for JSON-RPC messages)
- Binary message support (needed for voice audio chunks)
- Built-in pub/sub via `ws.subscribe(topic)` and `server.publish(topic, data)`
- Configurable max payload length
- Backpressure handling via `ws.sendText()` return value

### Streaming Support

Bun.serve() supports streaming responses via `ReadableStream`:

```typescript
return new Response(
  new ReadableStream({
    start(controller) {
      controller.enqueue("data: chunk1\n\n");
      controller.enqueue("data: chunk2\n\n");
      controller.close();
    },
  }),
  { headers: { "Content-Type": "text/event-stream" } },
);
```

This is used for Server-Sent Events (SSE) in the OpenAI-compatible `/v1/chat/completions` endpoint.

### TLS Support

```typescript
Bun.serve({
  port: 8419,
  tls: {
    cert: Bun.file("/path/to/cert.pem"),
    key: Bun.file("/path/to/key.pem"),
  },
  // ...
});
```

Native TLS support without external dependencies. Matches Eidolon's `gateway.tls` config.

## Compatibility Assessment

### What Works Well

1. **HTTP routing**: `fetch()` handler provides full control over request routing. Eidolon uses it for `/health`, `/metrics`, `/v1/chat/completions`, and WebSocket upgrade.
2. **WebSocket lifecycle**: `open`, `message`, `close` handlers map cleanly to Eidolon's client connection management.
3. **Binary WebSocket messages**: Critical for voice audio streaming (Opus frames).
4. **Concurrent connections**: Bun handles thousands of concurrent WebSocket connections efficiently.
5. **Hot module reloading**: During development, Bun's HMR keeps the server running while code changes.

### Limitations

1. **No built-in routing framework**: Unlike Express or Fastify, Bun.serve() provides only a raw `fetch()` handler. Eidolon implements its own routing in `server.ts` and `rpc-handlers.ts`. This is acceptable for our small API surface.
2. **No middleware chain**: Request processing (auth, rate limiting, logging) is handled manually. Again, acceptable given our small API surface.
3. **WebSocket `data` property**: Custom data attached to WebSocket connections uses `ws.data`, which requires careful typing. Eidolon handles this with a typed `ClientData` interface.

### Comparison with Alternatives

| Feature | Bun.serve() | Hono (on Bun) | Elysia (on Bun) |
|---|---|---|---|
| Performance | Native (fastest) | ~95% of native | ~90% of native |
| Routing | Manual | Declarative | Declarative |
| WebSocket | Native | Plugin | Native |
| Type safety | Manual typing | Good | Excellent (end-to-end) |
| Middleware | Manual | Yes | Yes |
| Bundle size | 0 (built-in) | ~50 KB | ~100 KB |
| Learning curve | Low | Low | Medium |

## Recommendation

**No migration needed. Bun.serve() is already the correct choice.**

Eidolon's gateway has a small API surface (health, metrics, OpenAI-compat, WebSocket) that does not benefit from a routing framework. The manual routing in `server.ts` is clear and maintainable.

### Potential Future Improvements

1. **Adopt Hono for HTTP routes**: If the HTTP API surface grows significantly (e.g., REST API for third-party integrations), migrating HTTP routing to Hono while keeping WebSocket on Bun.serve() would reduce boilerplate. Hono runs natively on Bun with minimal overhead.

2. **Leverage Bun.serve() pub/sub**: The built-in `ws.subscribe(topic)` and `server.publish(topic, data)` could replace the manual broadcast logic in the gateway for push events to multiple clients. Currently, Eidolon iterates over connected clients manually.

3. **Enable per-message deflate**: If bandwidth becomes a concern (many connected clients, verbose JSON-RPC messages), enable `perMessageDeflate: true` in the WebSocket config. This is a one-line change.

### Migration Path (If Ever Needed)

Since Bun.serve() is already in use, there is no migration. For reference, the current server setup in `packages/core/src/gateway/server.ts` follows Bun.serve() best practices:
- Single `fetch()` handler with URL-based routing
- WebSocket upgrade in the fetch handler
- Typed `ws.data` for client state
- Graceful shutdown via `server.stop()`
