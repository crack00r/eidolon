# Home Automation Integration

> **Status: Design — not yet implemented.**
> Created 2026-03-01 based on [expert review findings](../REVIEW_FINDINGS.md) (M-3).

## Rationale

Home Assistant integration is the #1 requested feature in the personal AI assistant community (per Reddit/HN research). It's also a natural fit for a voice-controlled assistant.

Eidolon integrates with Home Assistant via the existing MCP server (`mcp-server-home-assistant`), adding a security layer and entity resolution on top.

## Architecture

```
User: "Turn off the living room lights"
  │
  ├─ Eidolon Core: Cognitive Loop processes message
  │
  ├─ Entity Resolution: "living room lights" → light.living_room_ceiling
  │
  ├─ Security Policy: light.* actions → classification: "safe"
  │
  ├─ Claude Code Session (with HA MCP server):
  │   → Calls HA MCP tool: turn_off(entity_id: "light.living_room_ceiling")
  │
  └─ Response: "Done. Living room lights are off."
```

## Phase 4.5: Basic Integration (via MCP)

### Configuration

```jsonc
{
  "mcp": {
    "servers": [
      {
        "name": "home-assistant",
        "command": "uvx",
        "args": ["mcp-server-home-assistant"],
        "env": {
          "HA_URL": "http://homeassistant.local:8123",
          "HA_TOKEN": { "$secret": "HA_LONG_LIVED_TOKEN" }
        }
      }
    ]
  },
  "homeAssistant": {
    "enabled": true,
    "entityAliases": {
      "living room lights": "light.living_room_ceiling",
      "bedroom lights": "light.bedroom_main",
      "office": "light.office_desk",
      "front door": "lock.front_door",
      "thermostat": "climate.living_room"
    }
  }
}
```

### Security Policies for HA Actions

Not all HA actions are equal. Turning on a light is safe; unlocking a door is not.

```jsonc
{
  "security": {
    "policies": {
      // Lights and switches: safe to toggle
      "ha_light_control": "safe",
      "ha_switch_control": "safe",

      // Sensors: safe to read
      "ha_sensor_read": "safe",

      // Climate: needs confirmation for significant changes
      "ha_climate_control": "needs_approval",

      // Security-critical: always needs approval
      "ha_lock_control": "needs_approval",
      "ha_alarm_control": "dangerous",
      "ha_garage_control": "needs_approval",

      // Automations: careful with modification
      "ha_automation_trigger": "needs_approval",
      "ha_automation_modify": "dangerous"
    }
  }
}
```

### Entity Resolution

Natural language → HA entity ID mapping:

1. **Alias lookup:** Check `homeAssistant.entityAliases` config (user-defined)
2. **Fuzzy match:** Match against HA entity `friendly_name` attributes
3. **Room inference:** If user says "the lights" while context indicates they're in the living room (from recent conversation), resolve to living room lights
4. **Disambiguation:** If multiple matches, ask user: "Did you mean the ceiling lights or the desk lamp?"

### HA State in Memory Context

When HA is configured, MEMORY.md includes current home state:

```markdown
## Home State (Live)
- Living room lights: ON (brightness 80%)
- Bedroom lights: OFF
- Temperature: 21.5°C (target: 22°C)
- Front door: LOCKED
- Motion: none detected (last: 15 min ago)
```

This allows Eidolon to give contextual responses: "It's already 21.5°C, just half a degree below your target."

## Future: Advanced Integration (v1.1)

Features deferred to post-v1.0:

### Proactive Suggestions
- "It's getting dark. Want me to turn on the living room lights?"
- "Temperature has dropped to 19°C. Should I increase the thermostat?"
- "No motion detected for 30 minutes and lights are on. Turn them off?"

### Automation Scenes
- "Set up movie mode" → dim lights, lower blinds, turn on TV
- "Good night" → all lights off, doors locked, thermostat to night mode
- User-defined via conversation: "When I say 'movie time', dim the lights and turn on the TV"

### Energy Monitoring
- "How much electricity did I use this month?"
- Daily energy digest in Telegram

### Example Use Cases

| Use Case | Complexity | Phase |
|---|---|---|
| "Turn off the lights" | Simple entity control | 4.5 |
| "Is the front door locked?" | State query | 4.5 |
| "What's the temperature?" | Sensor read | 4.5 |
| "Set thermostat to 22°C" | Climate control (approval) | 4.5 |
| "Good night routine" | Multi-entity scene | v1.1 |
| "Turn on lights when I get home" | Automation creation | v1.1 |
| "How much energy this week?" | Analytics | v1.1 |
| Voice: "Hey Eidolon, lights off" | Voice-controlled HA | v1.1 |
