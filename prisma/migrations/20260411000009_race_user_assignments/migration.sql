CREATE TABLE "race_users" (
    "id" SERIAL NOT NULL,
    "user_id" INTEGER NOT NULL,
    "race_id" INTEGER NOT NULL,

    CONSTRAINT "race_users_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "race_users_user_id_race_id_key" ON "race_users"("user_id", "race_id");

ALTER TABLE "race_users"
    ADD CONSTRAINT "race_users_user_id_fkey"
    FOREIGN KEY ("user_id") REFERENCES "users"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "race_users"
    ADD CONSTRAINT "race_users_race_id_fkey"
    FOREIGN KEY ("race_id") REFERENCES "races"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;

INSERT INTO "race_users" ("user_id", "race_id")
SELECT u."id", r."id"
FROM "users" u
CROSS JOIN "races" r
WHERE r."slug" = 'carrera-actual'
  AND u."role" <> 'MASTER'
ON CONFLICT ("user_id", "race_id") DO NOTHING;
