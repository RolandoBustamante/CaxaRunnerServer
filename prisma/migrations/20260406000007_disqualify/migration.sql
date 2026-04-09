-- AlterTable
ALTER TABLE "finishers" ADD COLUMN "disqualified" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "finishers" ADD COLUMN "dq_reason" TEXT;
