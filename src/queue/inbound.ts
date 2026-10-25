import type PgBoss from "pg-boss";
import { QUEUES } from "../queues.js";
import type { InboundMessageJob } from "../zernio/types.js";

export interface InboundQueue {
  /** Enqueue one inbound message. `singletonKey` is the provider message id based dedupe key. */
  enqueue(job: InboundMessageJob, singletonKey: string): Promise<void>;
}

/** Customer text and phone numbers sit in job.data, so keep finished jobs only briefly (PDPL). */
const JOB_RETENTION_SECONDS = 3 * 24 * 3600;
/** Belt and braces on top of the Postgres dedupe table: pg-boss throttles identical singletonKeys within a slot. */
const SINGLETON_SECONDS = 24 * 3600;

export function createPgBossInboundQueue(boss: PgBoss): InboundQueue {
  return {
    async enqueue(job, singletonKey) {
      await boss.send(QUEUES.inboundMessage, job, {
        singletonKey,
        singletonSeconds: SINGLETON_SECONDS,
        retentionSeconds: JOB_RETENTION_SECONDS,
        retryLimit: 3,
        retryDelay: 5,
        retryBackoff: true,
      });
    },
  };
}
