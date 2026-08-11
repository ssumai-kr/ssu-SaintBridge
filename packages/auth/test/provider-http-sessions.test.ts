import type { FetchImplementation, HttpSession } from "@ssu-saintbridge/transport";
import { FetchHttpSession } from "@ssu-saintbridge/transport";
import type { ProviderId } from "@ssu-saintbridge/types";
import { describe, expect, it } from "vitest";

import { ProviderHttpSessionRegistry, ProviderHttpSessionRegistryError } from "../src/index.js";

const providerIds = ["usaint", "lms", "library"] as const satisfies readonly ProviderId[];
const upstreamUrl = new URL("https://saint.ssu.ac.kr/mock");

interface SessionObservation {
  readonly sentCookies: (string | null)[];
  readonly transport: HttpSession;
}

const createRegistry = (
  user: string,
  observations: Map<string, SessionObservation>,
): ProviderHttpSessionRegistry =>
  new ProviderHttpSessionRegistry(
    providerIds.map((provider) => ({ provider, allowedHosts: [upstreamUrl.hostname] })),
    {
      sessionFactory: ({ provider, urlPolicy }) => {
        let calls = 0;
        const sentCookies: (string | null)[] = [];
        const fetchImplementation: FetchImplementation = async (_input, init) => {
          sentCookies.push(new Headers(init?.headers).get("cookie"));
          const headers = new Headers();
          if (calls === 0) {
            headers.append("set-cookie", `MOCK_SESSION=${user}-${provider}; Path=/; Secure`);
          }
          calls += 1;
          return new Response("ok", { status: 200, headers });
        };
        const transport = new FetchHttpSession({
          fetchImplementation,
          maxRetries: 0,
          urlPolicy,
        });
        observations.set(`${user}:${provider}`, { sentCookies, transport });
        return transport;
      },
    },
  );

describe("ProviderHttpSessionRegistry", () => {
  it("isolates cookie jars across two users and three providers", async () => {
    const observations = new Map<string, SessionObservation>();
    const users = {
      alpha: createRegistry("alpha", observations),
      bravo: createRegistry("bravo", observations),
    };

    for (const registry of Object.values(users)) {
      for (const provider of providerIds) {
        await registry.get(provider).request({ method: "GET", url: upstreamUrl });
        await registry.get(provider).request({ method: "GET", url: upstreamUrl });
      }
    }

    for (const user of Object.keys(users)) {
      for (const provider of providerIds) {
        expect(observations.get(`${user}:${provider}`)?.sentCookies).toEqual([
          null,
          `MOCK_SESSION=${user}-${provider}`,
        ]);
      }
    }

    await Promise.all(Object.values(users).map(async (registry) => registry.close()));
  });

  it("closes one provider without damaging another provider session", async () => {
    const observations = new Map<string, SessionObservation>();
    const registry = createRegistry("alpha", observations);
    const lms = registry.get("lms");

    await registry.closeProvider("lms");
    expect(registry.has("lms")).toBe(false);
    expect(registry.has("usaint")).toBe(true);
    await expect(lms.request({ method: "GET", url: upstreamUrl })).rejects.toMatchObject({
      violation: "CLOSED",
    });
    await expect(
      registry.get("usaint").request({ method: "GET", url: upstreamUrl }),
    ).resolves.toMatchObject({ status: 200 });

    await registry.close();
  });

  it("rejects duplicate and missing provider configurations", () => {
    expect(
      () =>
        new ProviderHttpSessionRegistry([
          { provider: "usaint", allowedHosts: [upstreamUrl.hostname] },
          { provider: "usaint", allowedHosts: [upstreamUrl.hostname] },
        ]),
    ).toThrow(ProviderHttpSessionRegistryError);

    const registry = new ProviderHttpSessionRegistry([
      { provider: "usaint", allowedHosts: [upstreamUrl.hostname] },
    ]);
    expect(() => registry.get("lms")).toThrow(ProviderHttpSessionRegistryError);
  });

  it("serializes only lifecycle metadata", () => {
    const registry = new ProviderHttpSessionRegistry([
      { provider: "usaint", allowedHosts: [upstreamUrl.hostname] },
    ]);

    expect(JSON.parse(JSON.stringify(registry))).toEqual({
      closed: false,
      providers: ["usaint"],
    });
    expect(JSON.stringify(registry)).not.toContain(upstreamUrl.hostname);
  });
});
