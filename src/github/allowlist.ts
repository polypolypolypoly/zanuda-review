/**
 * Allowlist check used by the poller (and webhook handler) to decide whether
 * a given repo is permitted to request reviews.
 *
 * Extracted into its own module so it can be unit-tested without importing
 * the full poller.
 */

/**
 * Returns true if the repo is permitted by the allowlist.
 * An empty allowlist means "allow everyone".
 * Entries can be:
 *   "owner"        — matches any repo under that owner/org
 *   "owner/repo"   — matches only that specific repo
 */
export function isAllowed(
  ref: { owner: string; repo: string },
  allowlist: string[],
): boolean {
  if (allowlist.length === 0) return true;
  const full = `${ref.owner}/${ref.repo}`.toLowerCase();
  return allowlist.some((entry) => {
    const e = entry.toLowerCase();
    return e === ref.owner.toLowerCase() || e === full;
  });
}
