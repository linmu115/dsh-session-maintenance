/** A directory/registration label is not evidence that a DSH session was named. */
export function meaningfulDshTitle(title: unknown, identities: readonly (string | undefined)[]): string | null {
  if (typeof title !== "string") return null;
  const value = title.trim();
  if (!value) return null;
  for (const identity of identities) {
    if (!identity) continue;
    if (value === identity || value === `DSH session ${identity}`) return null;
  }
  return value;
}
