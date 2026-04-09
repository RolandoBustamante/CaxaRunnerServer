-- Drop old table
DROP TABLE IF EXISTS "participants";

-- Create new participants table
CREATE TABLE "participants" (
    "id" SERIAL NOT NULL,
    "documento" TEXT NOT NULL,
    "dorsal" TEXT,
    "nombre" TEXT NOT NULL,
    "edad" INTEGER NOT NULL,
    "genero" TEXT NOT NULL,
    "kit_entregado" BOOLEAN NOT NULL DEFAULT false,
    "carta_firmada" BOOLEAN NOT NULL DEFAULT false,

    CONSTRAINT "participants_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "participants_documento_key" ON "participants"("documento");
CREATE UNIQUE INDEX "participants_dorsal_key" ON "participants"("dorsal");
