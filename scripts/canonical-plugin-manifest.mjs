export const DSH_HOST_OWNED_PACKAGES = Object.freeze([
  "@deepseek-ai/cosmokit",
  "@deepseek-ai/schemastery",
]);

/**
 * DSH loads core packages from the CLI/runtime tree. A Generation plugin must
 * not make pnpm materialize a second copy in a Profile, because that copy can
 * come from a different Harness release and split Cordis/Schema identities.
 */
export function externalizeDshHostPackages(manifest) {
  const dependencies = { ...(manifest.dependencies ?? {}) };
  const optionalDependencies = { ...(manifest.optionalDependencies ?? {}) };
  const peerDependencies = { ...(manifest.peerDependencies ?? {}) };
  const peerDependenciesMeta = { ...(manifest.peerDependenciesMeta ?? {}) };

  for (const name of DSH_HOST_OWNED_PACKAGES) {
    const declared = Object.hasOwn(dependencies, name)
      || Object.hasOwn(optionalDependencies, name)
      || Object.hasOwn(peerDependencies, name);
    delete dependencies[name];
    delete optionalDependencies[name];
    if (!declared) continue;
    peerDependencies[name] = "*";
    peerDependenciesMeta[name] = {
      ...(peerDependenciesMeta[name] ?? {}),
      optional: true,
    };
  }

  return {
    ...manifest,
    dependencies,
    optionalDependencies,
    peerDependencies,
    peerDependenciesMeta,
  };
}
