// The signalk-doctor-server image version that "auto" resolves to.
// Bump this when a new signalk-doctor-server release is published to ghcr.io.
// Independent of signalk-doctor's own package.json version — the two repos
// release on independent cadences. See AGENTS.md "Gotchas" for rationale.
export const DOCTOR_SERVER_VERSION = '0.6.1';

export function resolveImageTag(tag: string): string {
  return tag === 'auto' ? DOCTOR_SERVER_VERSION : tag;
}
