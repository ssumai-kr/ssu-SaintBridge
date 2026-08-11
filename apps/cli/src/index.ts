#!/usr/bin/env node

import { createInitialBridgeStatus } from "@ssu-saintbridge/facade";

export const getCliInfo = () => ({
  name: "ssu-saintbridge",
  auth: createInitialBridgeStatus(),
});

if (process.argv[1]?.endsWith("index.js")) {
  process.stdout.write(`${JSON.stringify(getCliInfo())}\n`);
}
