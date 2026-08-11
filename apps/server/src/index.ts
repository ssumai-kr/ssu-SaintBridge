import { createInitialBridgeStatus } from "@ssu-saintbridge/facade";

export const getServiceInfo = () => ({
  name: "@ssu-saintbridge/server",
  auth: createInitialBridgeStatus(),
});
