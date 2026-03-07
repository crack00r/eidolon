#!/usr/bin/env bun

// @eidolon/cli -- CLI commands for the Eidolon daemon

import { VERSION } from "@eidolon/protocol";
import { Command } from "commander";
import { registerChannelCommand } from "./commands/channel.ts";
import { registerChatCommand } from "./commands/chat.ts";
import { registerConfigCommand } from "./commands/config.ts";
import { registerDaemonCommand } from "./commands/daemon.ts";
import { registerDoctorCommand } from "./commands/doctor.ts";
import { registerLearningCommand } from "./commands/learning.ts";
import { registerLlmCommand } from "./commands/llm.ts";
import { registerMcpCommand } from "./commands/mcp.ts";
import { registerMemoryCommand } from "./commands/memory.ts";
import { registerOnboardCommand } from "./commands/onboard.ts";
import { registerPairCommand } from "./commands/pair.ts";
import { registerPluginCommand } from "./commands/plugin.ts";
import { registerPrivacyCommand } from "./commands/privacy.ts";
import { registerProjectsCommand } from "./commands/projects.ts";
import { registerReplicationCommand } from "./commands/replication.ts";
import { registerSecretsCommand } from "./commands/secrets.ts";

const program = new Command();

program.name("eidolon").description("Autonomous, self-learning personal AI assistant").version(VERSION);

registerDaemonCommand(program);
registerConfigCommand(program);
registerSecretsCommand(program);
registerDoctorCommand(program);
registerChatCommand(program);
registerMcpCommand(program);
registerMemoryCommand(program);
registerLearningCommand(program);
registerChannelCommand(program);
registerPluginCommand(program);
registerLlmCommand(program);
registerPrivacyCommand(program);
registerOnboardCommand(program);
registerPairCommand(program);
registerProjectsCommand(program);
registerReplicationCommand(program);

program.parse();

export { program };
