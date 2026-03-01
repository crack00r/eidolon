#!/usr/bin/env bun

// @eidolon/cli -- CLI commands for the Eidolon daemon

import { VERSION } from "@eidolon/protocol";
import { Command } from "commander";
import { registerChannelCommand } from "./commands/channel.js";
import { registerChatCommand } from "./commands/chat.js";
import { registerConfigCommand } from "./commands/config.js";
import { registerDaemonCommand } from "./commands/daemon.js";
import { registerDoctorCommand } from "./commands/doctor.js";
import { registerLearningCommand } from "./commands/learning.js";
import { registerMemoryCommand } from "./commands/memory.js";
import { registerPrivacyCommand } from "./commands/privacy.js";
import { registerSecretsCommand } from "./commands/secrets.js";

const program = new Command();

program.name("eidolon").description("Autonomous, self-learning personal AI assistant").version(VERSION);

registerDaemonCommand(program);
registerConfigCommand(program);
registerSecretsCommand(program);
registerDoctorCommand(program);
registerChatCommand(program);
registerMemoryCommand(program);
registerLearningCommand(program);
registerChannelCommand(program);
registerPrivacyCommand(program);

program.parse();

export { program };
