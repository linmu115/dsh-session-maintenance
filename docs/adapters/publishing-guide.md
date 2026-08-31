# Publishing guide

- Use semantic versioning for the Adapter package itself.
- Set `adapterApiVersion` to the SDK interface major, not the DSH version.
- List versions with completed evidence in `testedDshVersions`.
- Keep `declaredDshRange` descriptive and broad enough for experimental probes.
- Publish a changelog, breaking-change notes, compatibility evidence, and the
  exact Core Smoke result.
- Do not bundle user data, DSH homes, projection output, credentials, or a
  Maintenance database.
- Register packages through Adapter Host; do not make the Adapter self-install
  or edit a Launcher Profile.
