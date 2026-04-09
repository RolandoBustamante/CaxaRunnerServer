-- CreateTable
CREATE TABLE "race_state" (
    "id" INTEGER NOT NULL DEFAULT 1,
    "started" BOOLEAN NOT NULL DEFAULT false,
    "start_time" BIGINT,

    CONSTRAINT "race_state_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "participants" (
    "dorsal" TEXT NOT NULL,
    "nombre" TEXT NOT NULL,
    "edad" INTEGER NOT NULL,
    "genero" TEXT NOT NULL,

    CONSTRAINT "participants_pkey" PRIMARY KEY ("dorsal")
);

-- CreateTable
CREATE TABLE "finishers" (
    "dorsal" TEXT NOT NULL,
    "position" INTEGER NOT NULL,
    "timestamp" BIGINT NOT NULL,
    "elapsed_ms" BIGINT NOT NULL,

    CONSTRAINT "finishers_pkey" PRIMARY KEY ("dorsal")
);
