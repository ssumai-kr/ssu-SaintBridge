import type { FetchImplementation, HttpSession } from "@ssu-saintbridge/transport";
import { FetchHttpSession } from "@ssu-saintbridge/transport";
import type { ProviderId } from "@ssu-saintbridge/types";
import { describe, expect, it } from "vitest";

import { ProviderHttpSessionRegistry, ProviderHttpSessionRegistryError } from "../src/index.js";

const providerIds = ["usaint", "lms", "library"] as const satisfies readonly ProviderId[];
const upstreamUrl = new URL("https://saint.ssu.ac.kr/mock");

interface SessionObservation {
  readonly provider: ProviderId;
  readonly sentCookies: (string | null)[];
  readonly transport: HttpSession;
}

const createRegistry = (
  user: string,
  observations: SessionObservation[],
): ProviderHttpSessionRegistry =>
  new ProviderHttpSessionRegistry(
    providerIds.map((provider) => ({ provider, allowedHosts: [upstreamUrl.hostname] })),
    {
      sessionFactory: ({ provider, urlPolicy }) => {
        const sequence = observations.filter(
          (observation) => observation.provider === provider,
        ).length;
        let calls = 0;
        const sentCookies: (string | null)[] = [];
        const fetchImplementation: FetchImplementation = async (_input, init) => {
          sentCookies.push(new Headers(init?.headers).get("cookie"));
          const headers = new Headers();
          if (calls === 0) {
            headers.append(
              "set-cookie",
              `MOCK_SESSION=${user}-${provider}-${sequence}; Path=/; Secure`,
            );
          }
          calls += 1;
          return new Response("ok", { status: 200, headers });
        };
        const transport = new FetchHttpSession({
          fetchImplementation,
          maxRetries: 0,
          urlPolicy,
        });
        observations.push({ provider, sentCookies, transport });
        return transport;
      },
    },
  );

const commitProviders = async (
  registry: ProviderHttpSessionRegistry,
  providers: readonly ProviderId[],
): Promise<readonly HttpSession[]> => {
  const sessions = providers.map((provider) => registry.createStaged(provider));
  await registry.commitStaged(
    providers.map((provider, index) => ({ provider, transport: sessions[index] as HttpSession })),
  );
  return sessions;
};

describe("ProviderHttpSessionRegistry", () => {
  it("isolates cookie jars across two users and three providers", async () => {
    const observations = {
      alpha: [] as SessionObservation[],
      bravo: [] as SessionObservation[],
    };
    const users = {
      alpha: createRegistry("alpha", observations.alpha),
      bravo: createRegistry("bravo", observations.bravo),
    };

    for (const registry of Object.values(users)) {
      await commitProviders(registry, providerIds);
      for (const provider of providerIds) {
        await registry.get(provider).request({ method: "GET", url: upstreamUrl });
        await registry.get(provider).request({ method: "GET", url: upstreamUrl });
      }
    }

    for (const [user, userObservations] of Object.entries(observations)) {
      for (const [sequence, provider] of providerIds.entries()) {
        expect(userObservations[sequence]?.sentCookies).toEqual([
          null,
          `MOCK_SESSION=${user}-${provider}-0`,
        ]);
      }
    }

    await Promise.all(Object.values(users).map(async (registry) => registry.close()));
  });

  it("keeps a previous provider active until its staged replacement commits", async () => {
    const observations: SessionObservation[] = [];
    const registry = createRegistry("alpha", observations);
    await commitProviders(registry, ["lms"]);
    const previous = registry.get("lms");
    await previous.request({ method: "GET", url: upstreamUrl });
    await previous.request({ method: "GET", url: upstreamUrl });

    const replacement = registry.createStaged("lms");
    await replacement.request({ method: "GET", url: upstreamUrl });
    expect(registry.get("lms")).toBe(previous);
    expect(observations[0]?.sentCookies).toEqual([null, "MOCK_SESSION=alpha-lms-0"]);
    expect(observations[1]?.sentCookies).toEqual([null]);

    await registry.commitStaged([{ provider: "lms", transport: replacement }]);
    expect(registry.get("lms")).toBe(replacement);
    await expect(previous.request({ method: "GET", url: upstreamUrl })).rejects.toMatchObject({
      violation: "CLOSED",
    });
    await replacement.request({ method: "GET", url: upstreamUrl });
    expect(observations[1]?.sentCookies).toEqual([null, "MOCK_SESSION=alpha-lms-1"]);

    await registry.close();
  });

  it("discards a staged provider without damaging an active provider", async () => {
    const observations: SessionObservation[] = [];
    const registry = createRegistry("alpha", observations);
    await commitProviders(registry, ["usaint"]);
    const stagedLms = registry.createStaged("lms");

    await registry.discardStaged(stagedLms);
    await expect(stagedLms.request({ method: "GET", url: upstreamUrl })).rejects.toMatchObject({
      violation: "CLOSED",
    });
    await expect(
      registry.get("usaint").request({ method: "GET", url: upstreamUrl }),
    ).resolves.toMatchObject({ status: 200 });
    expect(registry.has("usaint")).toBe(true);
    expect(registry.has("lms")).toBe(false);

    await registry.close();
  });

  it("validates every staged replacement before changing active sessions", async () => {
    const observations: SessionObservation[] = [];
    const registry = createRegistry("alpha", observations);
    const usaint = registry.createStaged("usaint");
    const lms = registry.createStaged("lms");

    expect(() =>
      registry.commitStaged([
        { provider: "usaint", transport: usaint },
        { provider: "usaint", transport: lms },
      ]),
    ).toThrow(ProviderHttpSessionRegistryError);
    expect(registry.has("usaint")).toBe(false);
    expect(registry.has("lms")).toBe(false);
    registry.assertStaged("usaint", usaint);
    registry.assertStaged("lms", lms);

    await registry.commitStaged([
      { provider: "usaint", transport: usaint },
      { provider: "lms", transport: lms },
    ]);
    expect(registry.has("usaint")).toBe(true);
    expect(registry.has("lms")).toBe(true);

    await registry.close();
  });

  it("rejects reused or malformed factory transports", async () => {
    const shared = new FetchHttpSession({
      fetchImplementation: async () => new Response("ok"),
      maxRetries: 0,
    });
    const reused = new ProviderHttpSessionRegistry(
      [{ provider: "lms", allowedHosts: [upstreamUrl.hostname] }],
      { sessionFactory: () => shared },
    );
    reused.createStaged("lms");
    expect(() => reused.createStaged("lms")).toThrowError(
      expect.objectContaining({ violation: "SESSION_FACTORY_REUSED_TRANSPORT" }),
    );
    await reused.close();

    const malformed = new ProviderHttpSessionRegistry(
      [{ provider: "lms", allowedHosts: [upstreamUrl.hostname] }],
      { sessionFactory: () => ({}) as HttpSession },
    );
    expect(() => malformed.createStaged("lms")).toThrowError(
      expect.objectContaining({ violation: "INVALID_SESSION_FACTORY_RESULT" }),
    );
  });

  it("separates configured providers from active provider sessions", () => {
    const registry = new ProviderHttpSessionRegistry([
      { provider: "usaint", allowedHosts: [upstreamUrl.hostname] },
    ]);

    expect(registry.isConfigured("usaint")).toBe(true);
    expect(registry.has("usaint")).toBe(false);
    expect(() => registry.get("usaint")).toThrowError(
      expect.objectContaining({ violation: "PROVIDER_SESSION_NOT_ACTIVE" }),
    );
    expect(() => registry.createStaged("lms")).toThrowError(
      expect.objectContaining({ violation: "PROVIDER_NOT_CONFIGURED" }),
    );
  });

  it("closes active and staged sessions together", async () => {
    const observations: SessionObservation[] = [];
    const registry = createRegistry("alpha", observations);
    await commitProviders(registry, ["usaint"]);
    const active = registry.get("usaint");
    const staged = registry.createStaged("lms");

    await registry.close();
    await expect(active.request({ method: "GET", url: upstreamUrl })).rejects.toMatchObject({
      violation: "CLOSED",
    });
    await expect(staged.request({ method: "GET", url: upstreamUrl })).rejects.toMatchObject({
      violation: "CLOSED",
    });
    expect(registry.has("usaint")).toBe(false);
    expect(registry.isConfigured("lms")).toBe(false);
  });

  it("serializes only provider lifecycle metadata", async () => {
    const registry = new ProviderHttpSessionRegistry([
      { provider: "usaint", allowedHosts: [upstreamUrl.hostname] },
      { provider: "lms", allowedHosts: [upstreamUrl.hostname] },
    ]);
    const usaint = registry.createStaged("usaint");
    registry.createStaged("lms");
    await registry.commitStaged([{ provider: "usaint", transport: usaint }]);

    expect(JSON.parse(JSON.stringify(registry))).toEqual({
      closed: false,
      providers: ["usaint"],
    });
    expect(JSON.stringify(registry)).not.toContain(upstreamUrl.hostname);
    await registry.close();
  });
});
