#!/usr/bin/env node

function getArg(name, fallback = "") {
  const i = process.argv.indexOf(`--${name}`);
  if (i === -1) return fallback;
  const v = process.argv[i + 1];
  return v ?? fallback;
}

const prompt = getArg("prompt", "");
const project = getArg("project", "demo_project");

function log(line) {
  process.stdout.write(line + "\n");
}
function err(line) {
  process.stderr.write(line + "\n");
}

log(`[agent] start`);
log(`[agent] project=${project}`);
log(`[agent] prompt=${prompt || "(empty)"}`);

let n = 0;
const timer = setInterval(() => {
  n += 1;
  log(`[agent] tick ${n}: working...`);
  if (n === 2) err(`[agent] (stderr) example warning line`);
  if (n >= 5) {
    clearInterval(timer);
    log(`[agent] done`);
    process.exit(0);
  }
}, 350);

// graceful shutdown
process.on("SIGINT", () => {
  err("[agent] interrupted (SIGINT)");
  process.exit(130);
});
