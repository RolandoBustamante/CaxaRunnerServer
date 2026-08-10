ALTER TABLE "races"
  ADD COLUMN "registration_rules_pdf_path" TEXT,
  ADD COLUMN "registration_rules_pdf_original_name" TEXT,
  ADD COLUMN "race_logo_path" TEXT,
  ADD COLUMN "race_logo_original_name" TEXT;

ALTER TABLE "registrations"
  ADD COLUMN "rules_accepted" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "rules_accepted_at" TIMESTAMP(3);
