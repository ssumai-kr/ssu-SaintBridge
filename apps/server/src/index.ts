import { createInitialProtocolStatus } from "@ssu-saintbridge/protocol";

export const getServiceInfo = () => ({
  name: "@ssu-saintbridge/server",
  protocol: createInitialProtocolStatus(),
});
