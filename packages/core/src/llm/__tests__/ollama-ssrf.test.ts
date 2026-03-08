/**
 * Tests for Ollama SSRF protection -- validateOllamaHost.
 *
 * Verifies that private/internal network addresses are rejected
 * unless explicitly allowed.
 */

import { describe, expect, test } from "bun:test";
import { validateOllamaHost } from "../ollama-provider.ts";

describe("validateOllamaHost", () => {
  describe("blocks private/internal addresses", () => {
    const blockedHosts = [
      "http://127.0.0.1:11434",
      "http://127.0.0.2:11434",
      "http://10.0.0.1:11434",
      "http://10.255.255.255:8080",
      "http://192.168.0.1:11434",
      "http://192.168.1.100:11434",
      "http://172.16.0.1:11434",
      "http://172.31.255.255:11434",
      "http://169.254.1.1:11434",
      "http://0.0.0.0:11434",
      "http://localhost:11434",
      "http://metadata.google.internal",
      "http://instance-data",
    ];

    for (const host of blockedHosts) {
      test(`rejects ${host}`, () => {
        expect(() => validateOllamaHost(host)).toThrow("SSRF protection");
      });
    }
  });

  describe("allows public addresses", () => {
    const allowedHosts = [
      "http://203.0.113.1:11434",
      "http://8.8.8.8:11434",
      "http://ollama.example.com:11434",
      "https://my-ollama-server.com",
    ];

    for (const host of allowedHosts) {
      test(`allows ${host}`, () => {
        expect(() => validateOllamaHost(host)).not.toThrow();
      });
    }
  });

  test("rejects invalid URL", () => {
    expect(() => validateOllamaHost("not-a-url")).toThrow("Invalid Ollama host URL");
  });

  test("allows private hosts when allowPrivateHosts is true", () => {
    expect(() => validateOllamaHost("http://127.0.0.1:11434", true)).not.toThrow();
    expect(() => validateOllamaHost("http://localhost:11434", true)).not.toThrow();
    expect(() => validateOllamaHost("http://10.0.0.1:11434", true)).not.toThrow();
  });

  describe("does not block valid private-looking but safe ranges", () => {
    test("allows 172.32.x.x (outside private range)", () => {
      expect(() => validateOllamaHost("http://172.32.0.1:11434")).not.toThrow();
    });

    test("allows 172.15.x.x (outside private range)", () => {
      expect(() => validateOllamaHost("http://172.15.0.1:11434")).not.toThrow();
    });
  });
});
