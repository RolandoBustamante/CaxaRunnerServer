-- Create registration settings on races
ALTER TABLE "races" ADD COLUMN "registrations_enabled" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "races" ADD COLUMN "registration_prices" JSONB;
ALTER TABLE "races" ADD COLUMN "registration_instructions" TEXT;

-- Create registrations
CREATE TABLE "registrations" (
  "id" SERIAL NOT NULL,
  "race_id" INTEGER NOT NULL,
  "code" TEXT NOT NULL,
  "review_token" TEXT NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'PENDING',
  "contact_name" TEXT NOT NULL,
  "contact_phone" TEXT,
  "contact_email" TEXT,
  "total_amount" DECIMAL(10,2),
  "payment_mode" TEXT NOT NULL DEFAULT 'ONE_VOUCHER',
  "notes" TEXT,
  "approved_at" TIMESTAMP(3),
  "rejected_at" TIMESTAMP(3),
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "registrations_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "registration_participants" (
  "id" SERIAL NOT NULL,
  "registration_id" INTEGER NOT NULL,
  "documento" TEXT NOT NULL,
  "nombre" TEXT NOT NULL,
  "birth_date" TIMESTAMP(3) NOT NULL,
  "genero" TEXT NOT NULL,
  "distancia" TEXT NOT NULL,
  "procedencia" TEXT NOT NULL,
  "blood_type" TEXT NOT NULL,
  "garment_type" TEXT NOT NULL,
  "garment_size" TEXT NOT NULL,
  "club" TEXT,
  "emergency_name" TEXT,
  "emergency_phone" TEXT,
  "photo_file_name" TEXT,
  "photo_original_name" TEXT,
  "photo_mime_type" TEXT,
  "photo_size_bytes" INTEGER,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "registration_participants_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "registration_vouchers" (
  "id" SERIAL NOT NULL,
  "registration_id" INTEGER NOT NULL,
  "file_name" TEXT NOT NULL,
  "original_name" TEXT NOT NULL,
  "mime_type" TEXT NOT NULL,
  "size_bytes" INTEGER NOT NULL,
  "amount" DECIMAL(10,2),
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "registration_vouchers_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "registrations_code_key" ON "registrations"("code");
CREATE UNIQUE INDEX "registrations_review_token_key" ON "registrations"("review_token");
CREATE INDEX "registrations_race_id_status_idx" ON "registrations"("race_id", "status");
CREATE INDEX "registration_participants_documento_idx" ON "registration_participants"("documento");

ALTER TABLE "registrations" ADD CONSTRAINT "registrations_race_id_fkey" FOREIGN KEY ("race_id") REFERENCES "races"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "registration_participants" ADD CONSTRAINT "registration_participants_registration_id_fkey" FOREIGN KEY ("registration_id") REFERENCES "registrations"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "registration_vouchers" ADD CONSTRAINT "registration_vouchers_registration_id_fkey" FOREIGN KEY ("registration_id") REFERENCES "registrations"("id") ON DELETE CASCADE ON UPDATE CASCADE;
