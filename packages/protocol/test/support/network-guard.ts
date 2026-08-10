const loopbackHosts = new Set(["127.0.0.1", "[::1]", "::1"]);

export const assertTestNetworkUrlAllowed = (input: string | URL): URL => {
  const url = input instanceof URL ? input : new URL(input);
  if (!loopbackHosts.has(url.hostname) || (url.protocol !== "http:" && url.protocol !== "https:")) {
    throw new Error(`External network access is blocked in tests: ${url.origin}`);
  }
  return url;
};

export const installTestNetworkGuard = (): void => {
  const originalFetch = globalThis.fetch;

  globalThis.fetch = ((input, init) => {
    const inputUrl = typeof input === "string" || input instanceof URL ? input : new URL(input.url);
    assertTestNetworkUrlAllowed(inputUrl);
    return originalFetch(input, init);
  }) as typeof fetch;
};
