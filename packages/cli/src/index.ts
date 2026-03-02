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
import { registerMemoryCommand } from "./commands/memory.ts";
import { registerOnboardCommand } from "./commands/onboard.ts";
import { registerPrivacyCommand } from "./commands/privacy.ts";
import { registerSecretsCommand } from "./commands/secrets.ts";

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
registerOnboardCommand(program);

program.parse();

export { program };
