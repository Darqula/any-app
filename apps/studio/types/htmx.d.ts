/**
 * htmx 2.0.4 loads from the CDN before any studio script; only this piece is used (client/home/).
 */
declare var htmx: {
  /** Reprocess elements htmx knows nothing about yet (freshly swapped-in sidebar content). */
  process(elt: Element): void;
};
