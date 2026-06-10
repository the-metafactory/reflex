#!/usr/bin/env bun
import { runCommand } from "../cli/main";

const rendered = await runCommand(process.argv.slice(2));
if (rendered.stdout) console.log(rendered.stdout);
if (rendered.stderr) console.error(rendered.stderr);
process.exit(rendered.exitCode);
