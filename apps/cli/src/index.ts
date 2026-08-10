#!/usr/bin/env node

import { createInitialProtocolStatus } from "@ssu-saintbridge/protocol";

export const getCliInfo = () => ({
  name: "ssu-saintbridge",
  protocol: createInitialProtocolStatus(),
});

if (process.argv[1]?.endsWith("index.js")) {
  process.stdout.write(`${JSON.stringify(getCliInfo())}\n`);
}
