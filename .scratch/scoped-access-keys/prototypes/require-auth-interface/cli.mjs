#!/usr/bin/env node
// PROTOTYPE — disposable TUI for inspecting the proposed requireAuth interface.

import { evaluate, scenarios } from "./model.mjs";

const bold = "\x1b[1m";
const dim = "\x1b[2m";
const reset = "\x1b[0m";
let index = 0;

function render() {
  console.clear();
  const scenario = scenarios[index];
  const result = evaluate(scenario);
  console.log(`${bold}PROTOTYPE — requireAuth Access-key interface${reset}`);
  console.log(`${dim}Scenario ${index + 1}/${scenarios.length}${reset}: ${scenario.name}\n`);
  console.log(`${bold}Input${reset}`);
  console.log(JSON.stringify({ wrapper: scenario.wrapper, presented: scenario.presented, userCheck: scenario.userCheck }, null, 2));
  console.log(`\n${bold}Observed phases${reset}`);
  result.phases.forEach((phase, phaseIndex) => console.log(`${phaseIndex + 1}. ${phase}`));
  console.log(`\n${bold}Final state${reset}`);
  console.log(JSON.stringify(result, null, 2));
  console.log(`\n${bold}[n]${reset} ${dim}next${reset}  ${bold}[p]${reset} ${dim}previous${reset}  ${bold}[q]${reset} ${dim}quit${reset}`);
}

if (!process.stdin.isTTY) {
  console.error("Run this prototype in an interactive terminal.");
  process.exitCode = 1;
} else {
  process.stdin.setRawMode(true);
  process.stdin.setEncoding("utf8");
  process.stdin.resume();
  process.stdin.on("data", (key) => {
    if (key === "q" || key === "\u0003") {
      console.clear();
      process.exit(0);
    }
    if (key === "n" || key === "\u001b[C") index = (index + 1) % scenarios.length;
    if (key === "p" || key === "\u001b[D") index = (index - 1 + scenarios.length) % scenarios.length;
    render();
  });
  render();
}
