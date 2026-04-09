-- Add distancia field to participants
ALTER TABLE "participants" ADD COLUMN "distancia" TEXT NOT NULL DEFAULT '10K';
