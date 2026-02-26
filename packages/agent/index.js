#!/usr/bin/env node
import { execa } from "execa";

function log(line) {
  // Agent schreibt immer als plain text nach stdout.
  process.stdout.write(line + "\n");
}

async function main() {
  log("Agent: starting...");
  log("Agent: node=" + process.version);

  try {
    const { stdout: flutterV } = await execa("flutter", ["--version"], { timeout: 20000 });
    log("Agent: flutter found ✅");
    log(flutterV.split("\n").slice(0, 3).join("\n"));
  } catch (e) {
    log("Agent: flutter not found ❌");
    log(String(e));
  }

  log("Agent: done.");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
