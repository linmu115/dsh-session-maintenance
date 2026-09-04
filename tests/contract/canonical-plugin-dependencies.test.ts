import { describe, expect, it } from "vitest";

import {
  DSH_HOST_OWNED_PACKAGES,
  externalizeDshHostPackages,
} from "../../scripts/canonical-plugin-manifest.mjs";

describe("canonical Generation plugin dependencies", () => {
  it("externalizes DSH core packages as optional open peers", () => {
    const manifest = externalizeDshHostPackages({
      name: "fixture-plugin",
      dependencies: {
        "@deepseek-ai/schemastery": "^3.18.1",
        zod: "^4.4.3",
      },
      optionalDependencies: {
        "@deepseek-ai/cosmokit": "1.8.2",
      },
      peerDependencies: {
        react: "*",
      },
      peerDependenciesMeta: {
        react: { optional: true },
      },
    });

    expect(manifest.dependencies).toEqual({ zod: "^4.4.3" });
    expect(manifest.optionalDependencies).toEqual({});
    for (const name of DSH_HOST_OWNED_PACKAGES) {
      expect(manifest.peerDependencies[name]).toBe("*");
      expect(manifest.peerDependenciesMeta[name]).toMatchObject({ optional: true });
    }
    expect(manifest.peerDependencies.react).toBe("*");
    expect(manifest.peerDependenciesMeta.react).toEqual({ optional: true });
  });

  it("does not add undeclared DSH core peers", () => {
    const manifest = externalizeDshHostPackages({
      name: "plain-plugin",
      dependencies: { zod: "^4.4.3" },
    });

    expect(manifest.dependencies).toEqual({ zod: "^4.4.3" });
    expect(manifest.peerDependencies).toEqual({});
    expect(manifest.peerDependenciesMeta).toEqual({});
  });
});
