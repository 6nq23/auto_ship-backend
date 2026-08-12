-- CreateEnum
CREATE TYPE "Role" AS ENUM ('admin', 'packer');

-- CreateEnum
CREATE TYPE "ShippingJobStatus" AS ENUM ('queued', 'processing', 'completed', 'failed');

-- CreateTable
CREATE TABLE "users" (
    "id" SERIAL NOT NULL,
    "username" TEXT NOT NULL,
    "username_normalized" TEXT NOT NULL,
    "password_hash" TEXT NOT NULL,
    "role" "Role" NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "users_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "order_cache" (
    "order_number" TEXT NOT NULL,
    "order_id" TEXT NOT NULL,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "order_cache_pkey" PRIMARY KEY ("order_number")
);

-- CreateTable
CREATE TABLE "shipping_batches" (
    "batch_id" UUID NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL,
    "shipped_by" TEXT NOT NULL,
    "payload" JSONB NOT NULL,

    CONSTRAINT "shipping_batches_pkey" PRIMARY KEY ("batch_id")
);

-- CreateTable
CREATE TABLE "shipping_jobs" (
    "job_id" UUID NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "created_by" TEXT NOT NULL,
    "status" "ShippingJobStatus" NOT NULL,
    "active_owner_key" TEXT,
    "payload" JSONB NOT NULL,

    CONSTRAINT "shipping_jobs_pkey" PRIMARY KEY ("job_id")
);

-- CreateIndex
CREATE UNIQUE INDEX "users_username_normalized_key" ON "users"("username_normalized");

-- CreateIndex
CREATE INDEX "shipping_batches_created_at_idx" ON "shipping_batches"("created_at" DESC);

-- CreateIndex
CREATE UNIQUE INDEX "shipping_jobs_active_owner_key_key" ON "shipping_jobs"("active_owner_key");

-- CreateIndex
CREATE INDEX "shipping_jobs_created_by_updated_at_idx" ON "shipping_jobs"("created_by", "updated_at" DESC);

-- CreateIndex
CREATE INDEX "shipping_jobs_status_created_at_idx" ON "shipping_jobs"("status", "created_at");
