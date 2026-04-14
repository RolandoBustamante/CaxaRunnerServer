-- Create races table
CREATE TABLE "races" (
    "id" SERIAL NOT NULL,
    "slug" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "event_date" TIMESTAMP(3),
    "status" TEXT NOT NULL DEFAULT 'DRAFT',
    "is_official" BOOLEAN NOT NULL DEFAULT false,
    "started" BOOLEAN NOT NULL DEFAULT false,
    "start_time" BIGINT,
    "closed" BOOLEAN NOT NULL DEFAULT false,
    "end_time" BIGINT,
    "categories" JSONB,
    "distances" JSONB,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "races_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "races_slug_key" ON "races"("slug");

-- Seed a default race from the legacy singleton state.
-- Some databases were created with camelCase legacy columns instead of snake_case.
DO $$
DECLARE
    start_column TEXT;
    end_column TEXT;
BEGIN
    SELECT CASE
        WHEN EXISTS (
            SELECT 1
            FROM information_schema.columns
            WHERE table_schema = current_schema()
              AND table_name = 'race_state'
              AND column_name = 'start_time'
        ) THEN 'start_time'
        WHEN EXISTS (
            SELECT 1
            FROM information_schema.columns
            WHERE table_schema = current_schema()
              AND table_name = 'race_state'
              AND column_name = 'startTime'
        ) THEN 'startTime'
        ELSE NULL
    END
    INTO start_column;

    SELECT CASE
        WHEN EXISTS (
            SELECT 1
            FROM information_schema.columns
            WHERE table_schema = current_schema()
              AND table_name = 'race_state'
              AND column_name = 'end_time'
        ) THEN 'end_time'
        WHEN EXISTS (
            SELECT 1
            FROM information_schema.columns
            WHERE table_schema = current_schema()
              AND table_name = 'race_state'
              AND column_name = 'endTime'
        ) THEN 'endTime'
        ELSE NULL
    END
    INTO end_column;

    EXECUTE format(
        'INSERT INTO "races" (
            "slug",
            "name",
            "status",
            "is_official",
            "started",
            "start_time",
            "closed",
            "end_time"
        )
        SELECT
            %L,
            %L,
            CASE WHEN COALESCE(rs."started", false) THEN %L ELSE %L END,
            false,
            COALESCE(rs."started", false),
            %s,
            COALESCE(rs."closed", false),
            %s
        FROM "race_state" rs
        WHERE rs."id" = 1
        ON CONFLICT ("slug") DO NOTHING',
        'carrera-actual',
        'Carrera actual',
        'TESTING',
        'DRAFT',
        CASE
            WHEN start_column IS NULL THEN 'NULL'
            ELSE format('rs.%I', start_column)
        END,
        CASE
            WHEN end_column IS NULL THEN 'NULL'
            ELSE format('rs.%I', end_column)
        END
    );
END $$;

INSERT INTO "races" ("slug", "name")
SELECT 'carrera-actual', 'Carrera actual'
WHERE NOT EXISTS (
    SELECT 1 FROM "races" WHERE "slug" = 'carrera-actual'
);

-- Move global categories config into the default race if present
UPDATE "races"
SET "categories" = (
    SELECT CAST("value" AS JSONB)
    FROM "config"
    WHERE "key" = 'categories'
)
WHERE "slug" = 'carrera-actual'
  AND EXISTS (SELECT 1 FROM "config" WHERE "key" = 'categories');

-- Normalize legacy camelCase participant columns if they exist
DO $$
BEGIN
    IF EXISTS (
        SELECT 1
        FROM information_schema.columns
        WHERE table_schema = current_schema()
          AND table_name = 'participants'
          AND column_name = 'kitEntregado'
    ) AND NOT EXISTS (
        SELECT 1
        FROM information_schema.columns
        WHERE table_schema = current_schema()
          AND table_name = 'participants'
          AND column_name = 'kit_entregado'
    ) THEN
        EXECUTE 'ALTER TABLE "participants" RENAME COLUMN "kitEntregado" TO "kit_entregado"';
    END IF;

    IF EXISTS (
        SELECT 1
        FROM information_schema.columns
        WHERE table_schema = current_schema()
          AND table_name = 'participants'
          AND column_name = 'cartaFirmada'
    ) AND NOT EXISTS (
        SELECT 1
        FROM information_schema.columns
        WHERE table_schema = current_schema()
          AND table_name = 'participants'
          AND column_name = 'carta_firmada'
    ) THEN
        EXECUTE 'ALTER TABLE "participants" RENAME COLUMN "cartaFirmada" TO "carta_firmada"';
    END IF;
END $$;

-- Participants become race-scoped
ALTER TABLE "participants"
    ADD COLUMN "race_id" INTEGER,
    ADD COLUMN "is_test_data" BOOLEAN NOT NULL DEFAULT false;

UPDATE "participants"
SET "race_id" = (SELECT "id" FROM "races" WHERE "slug" = 'carrera-actual' LIMIT 1)
WHERE "race_id" IS NULL;

ALTER TABLE "participants"
    ALTER COLUMN "race_id" SET NOT NULL;

DROP INDEX IF EXISTS "participants_documento_key";
DROP INDEX IF EXISTS "participants_dorsal_key";

ALTER TABLE "participants"
    ADD CONSTRAINT "participants_race_id_fkey"
    FOREIGN KEY ("race_id") REFERENCES "races"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;

CREATE UNIQUE INDEX "participants_race_id_documento_key"
    ON "participants"("race_id", "documento");

CREATE UNIQUE INDEX "participants_race_id_dorsal_key"
    ON "participants"("race_id", "dorsal");

-- Normalize legacy camelCase finisher columns if they exist
DO $$
BEGIN
    IF EXISTS (
        SELECT 1
        FROM information_schema.columns
        WHERE table_schema = current_schema()
          AND table_name = 'finishers'
          AND column_name = 'elapsedMs'
    ) AND NOT EXISTS (
        SELECT 1
        FROM information_schema.columns
        WHERE table_schema = current_schema()
          AND table_name = 'finishers'
          AND column_name = 'elapsed_ms'
    ) THEN
        EXECUTE 'ALTER TABLE "finishers" RENAME COLUMN "elapsedMs" TO "elapsed_ms"';
    END IF;

    IF EXISTS (
        SELECT 1
        FROM information_schema.columns
        WHERE table_schema = current_schema()
          AND table_name = 'finishers'
          AND column_name = 'dqReason'
    ) AND NOT EXISTS (
        SELECT 1
        FROM information_schema.columns
        WHERE table_schema = current_schema()
          AND table_name = 'finishers'
          AND column_name = 'dq_reason'
    ) THEN
        EXECUTE 'ALTER TABLE "finishers" RENAME COLUMN "dqReason" TO "dq_reason"';
    END IF;
END $$;

-- Finishers become race-scoped
ALTER TABLE "finishers"
    ADD COLUMN "id" SERIAL,
    ADD COLUMN "race_id" INTEGER,
    ADD COLUMN "is_test_data" BOOLEAN NOT NULL DEFAULT false;

UPDATE "finishers"
SET "race_id" = (SELECT "id" FROM "races" WHERE "slug" = 'carrera-actual' LIMIT 1)
WHERE "race_id" IS NULL;

ALTER TABLE "finishers"
    ALTER COLUMN "race_id" SET NOT NULL;

ALTER TABLE "finishers" DROP CONSTRAINT "finishers_pkey";
ALTER TABLE "finishers" ADD CONSTRAINT "finishers_pkey" PRIMARY KEY ("id");

ALTER TABLE "finishers"
    ADD CONSTRAINT "finishers_race_id_fkey"
    FOREIGN KEY ("race_id") REFERENCES "races"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;

CREATE UNIQUE INDEX "finishers_race_id_dorsal_key"
    ON "finishers"("race_id", "dorsal");

-- Infer known distances into the default race
UPDATE "races"
SET "distances" = (
    SELECT COALESCE(jsonb_agg(dist_value ORDER BY dist_value), '[]'::jsonb)
    FROM (
        SELECT DISTINCT to_jsonb("distancia") AS dist_value
        FROM "participants"
        WHERE "race_id" = "races"."id"
    ) AS dist_rows
)
WHERE "slug" = 'carrera-actual';
