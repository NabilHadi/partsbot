/** pg-boss queue names, kept in one place and free of side effects so both the API and the worker can import it. */
export const QUEUES = {
  inboundMessage: "inbound-message",
} as const;
