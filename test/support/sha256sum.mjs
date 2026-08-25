#!/usr/bin/env node
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

const file = process.argv[2];
if (!file) process.exit(64);
const checksum = createHash("sha256").update(readFileSync(file)).digest("hex");
process.stdout.write(`${checksum}  ${file}\n`);
