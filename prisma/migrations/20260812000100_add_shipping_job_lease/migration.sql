-- A lease prevents multiple serverless instances from processing the same job.
ALTER TABLE "shipping_jobs" ADD COLUMN "lease_until" TIMESTAMP(3);
