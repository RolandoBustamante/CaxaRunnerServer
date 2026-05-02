ALTER TABLE "races"
    ADD COLUMN "certificates_enabled" BOOLEAN NOT NULL DEFAULT true,
    ADD COLUMN "show_dorsal_public" BOOLEAN NOT NULL DEFAULT true;
