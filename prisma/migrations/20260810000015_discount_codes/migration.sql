ALTER TABLE "registrations" ADD COLUMN "subtotal_amount" DECIMAL(10,2);
ALTER TABLE "registrations" ADD COLUMN "discount_code_id" INTEGER;
ALTER TABLE "registrations" ADD COLUMN "discount_code_text" TEXT;
ALTER TABLE "registrations" ADD COLUMN "discount_percent" DECIMAL(5,2);
ALTER TABLE "registrations" ADD COLUMN "discount_amount" DECIMAL(10,2);

CREATE TABLE "discount_codes" (
  "id" SERIAL NOT NULL,
  "race_id" INTEGER NOT NULL,
  "code" TEXT NOT NULL,
  "percent" DECIMAL(5,2) NOT NULL,
  "max_uses" INTEGER,
  "valid_until" TIMESTAMP(3),
  "active" BOOLEAN NOT NULL DEFAULT true,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "discount_codes_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "discount_codes_race_id_code_key" ON "discount_codes"("race_id", "code");
CREATE INDEX "discount_codes_race_id_active_idx" ON "discount_codes"("race_id", "active");
CREATE INDEX "registrations_discount_code_id_idx" ON "registrations"("discount_code_id");

ALTER TABLE "discount_codes" ADD CONSTRAINT "discount_codes_race_id_fkey" FOREIGN KEY ("race_id") REFERENCES "races"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "registrations" ADD CONSTRAINT "registrations_discount_code_id_fkey" FOREIGN KEY ("discount_code_id") REFERENCES "discount_codes"("id") ON DELETE SET NULL ON UPDATE CASCADE;
