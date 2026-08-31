#!/usr/bin/env node
import { runCli } from "./cli.js";
import { launcherStateRoot } from "./config.js";

const argv = process.argv.slice(2);
const registeredRoot = launcherStateRoot();
const effectiveArgs = registeredRoot !== undefined && !argv.includes("--state-root")
  ? ["--state-root", registeredRoot, ...argv]
  : argv;

process.exitCode = await runCli(effectiveArgs);
