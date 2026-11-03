/**
 * A reading is chained and sent only once it has been stored this long. A controller that replays a
 * backlog can deliver an older reading after a newer one; waiting lets the older one take its place
 * in time order instead of being set aside as late.
 */
export const DEFAULT_SETTLE_MS = 120_000;
