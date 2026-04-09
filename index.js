require("dotenv").config();
const express = require("express");
const cors = require("cors");

const { PrismaClient } = require("./generated/prisma");
const requireAuth = require("./middleware/auth");
const authRouter = require("./routes/auth");

const prisma = new PrismaClient();
const app = express();

app.use(cors());
app.use(express.json());

// Auth routes — /api/auth/login, /api/auth/me, /api/auth/users
app.use("/api/auth", authRouter);

// ── GET /api/public — sin autenticación (vista pública) ───────────────────
app.get("/api/public", async (req, res) => {
  try {
    const [race, finishers] = await Promise.all([
      prisma.raceState.upsert({
        where: { id: 1 },
        update: {},
        create: { id: 1, started: false },
      }),
      prisma.finisher.findMany({ orderBy: { position: "asc" }, take: 10 }),
    ]);
    res.json({
      serverNow: Date.now(),
      raceStarted: race.started,
      raceClosed: race.closed,
      raceStartTime: race.startTime ? Number(race.startTime) : null,
      finishersCount: await prisma.finisher.count(),
      topFinishers: finishers.map(serializeFinisher),
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Error" });
  }
});

// Proteger todas las rutas /api/* siguientes
app.use("/api", requireAuth);

// ── Helpers ────────────────────────────────────────────────────────────────

function serializeFinisher(f) {
  return {
    dorsal: f.dorsal,
    position: f.position,
    timestamp: Number(f.timestamp),
    elapsedMs: Number(f.elapsedMs) / 1000, // stored as μs, returned as ms (float)
    disqualified: f.disqualified,
    dqReason: f.dqReason ?? null,
  };
}

// ── GET /api/race ──────────────────────────────────────────────────────────
// Returns full race state: race info + participants + ordered finishers
app.get("/api/race", async (req, res) => {
  try {
    const [race, participants, finishers] = await Promise.all([
      prisma.raceState.upsert({
        where: { id: 1 },
        update: {},
        create: { id: 1, started: false },
      }),
      prisma.participant.findMany({ orderBy: { nombre: "asc" } }),
      prisma.finisher.findMany({ orderBy: { position: "asc" } }),
    ]);

    res.json({
      serverNow: Date.now(),
      raceStarted: race.started,
      raceClosed: race.closed,
      raceStartTime: race.startTime ? Number(race.startTime) : null,
      raceEndTime: race.endTime ? Number(race.endTime) : null,
      participants,
      finishers: finishers.map(serializeFinisher),
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Error al obtener estado de la carrera" });
  }
});

// ── POST /api/race/start ───────────────────────────────────────────────────
app.post("/api/race/start", async (req, res) => {
  try {
    const now = BigInt(Date.now());
    await prisma.$transaction([
      prisma.raceState.upsert({
        where: { id: 1 },
        update: { started: true, closed: false, startTime: now },
        create: { id: 1, started: true, closed: false, startTime: now },
      }),
      prisma.finisher.deleteMany(),
    ]);
    res.json({ success: true, startTime: Number(now) });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Error al iniciar la carrera" });
  }
});

// ── POST /api/race/close ───────────────────────────────────────────────────
app.post("/api/race/close", async (req, res) => {
  try {
    const now = BigInt(Date.now());
    await prisma.raceState.upsert({
      where: { id: 1 },
      update: { closed: true, endTime: now },
      create: { id: 1, started: false, closed: true, endTime: now },
    });
    res.json({ success: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Error al cerrar la carrera" });
  }
});

// ── POST /api/race/reset-results ──────────────────────────────────────────
// Borra finishers y resetea estado de carrera, pero mantiene participantes
app.post("/api/race/reset-results", async (req, res) => {
  try {
    await prisma.$transaction([
      prisma.finisher.deleteMany(),
      prisma.raceState.upsert({
        where: { id: 1 },
        update: { started: false, closed: false, startTime: null, endTime: null },
        create: { id: 1, started: false, closed: false, startTime: null, endTime: null },
      }),
    ]);
    res.json({ success: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Error al limpiar resultados" });
  }
});

// ── POST /api/race/reset ───────────────────────────────────────────────────
app.post("/api/race/reset", async (req, res) => {
  try {
    await prisma.$transaction([
      prisma.finisher.deleteMany(),
      prisma.participant.deleteMany(),
      prisma.raceState.upsert({
        where: { id: 1 },
        update: { started: false, closed: false, startTime: null, endTime: null },
        create: { id: 1, started: false, closed: false, startTime: null, endTime: null },
      }),
    ]);
    res.json({ success: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Error al resetear la carrera" });
  }
});

// ── POST /api/participants ─────────────────────────────────────────────────
// Bulk upload: upsert by documento
app.post("/api/participants", async (req, res) => {
  const { participants } = req.body;
  if (!Array.isArray(participants) || participants.length === 0) {
    return res.status(400).json({ error: "participants debe ser un array no vacío" });
  }

  try {
    const results = await prisma.$transaction(
      participants.map((p) =>
        prisma.participant.upsert({
          where: { documento: String(p.documento).trim() },
          update: {
            nombre: String(p.nombre).trim(),
            edad: Number(p.edad),
            genero: String(p.genero).trim().toUpperCase(),
            distancia: String(p.distancia).trim().toUpperCase(),
            ...(p.dorsal !== undefined && p.dorsal !== null && String(p.dorsal).trim() !== ""
              ? { dorsal: String(p.dorsal).trim() }
              : {}),
          },
          create: {
            documento: String(p.documento).trim(),
            nombre: String(p.nombre).trim(),
            edad: Number(p.edad),
            genero: String(p.genero).trim().toUpperCase(),
            distancia: String(p.distancia).trim().toUpperCase(),
            dorsal:
              p.dorsal !== undefined && p.dorsal !== null && String(p.dorsal).trim() !== ""
                ? String(p.dorsal).trim()
                : null,
          },
        })
      )
    );
    res.json({ success: true, count: results.length });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Error al guardar participantes" });
  }
});

// ── GET /api/participants/search ───────────────────────────────────────────
// Search participant by documento or nombre (partial match)
app.get("/api/participants/search", async (req, res) => {
  const q = String(req.query.q || "").trim();
  if (!q) {
    return res.json([]);
  }

  try {
    const results = await prisma.participant.findMany({
      where: {
        OR: [
          { documento: { contains: q, mode: "insensitive" } },
          { nombre: { contains: q, mode: "insensitive" } },
        ],
      },
      orderBy: { nombre: "asc" },
      take: 20,
    });
    res.json(results);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Error al buscar participante" });
  }
});

// ── POST /api/participants/:id/dorsal ──────────────────────────────────────
// Assign dorsal to a participant
app.post("/api/participants/:id/dorsal", async (req, res) => {
  const id = parseInt(req.params.id, 10);
  const { dorsal } = req.body;
  if (!dorsal) return res.status(400).json({ error: "dorsal requerido" });

  try {
    const participant = await prisma.participant.update({
      where: { id },
      data: { dorsal: String(dorsal).trim() },
    });
    res.json({ success: true, participant });
  } catch (err) {
    if (err.code === "P2002") {
      return res.status(409).json({ error: "Este dorsal ya está asignado a otro participante" });
    }
    if (err.code === "P2025") {
      return res.status(404).json({ error: "Participante no encontrado" });
    }
    console.error(err);
    res.status(500).json({ error: "Error al asignar dorsal" });
  }
});

// ── POST /api/participants/:id/kit ─────────────────────────────────────────
// Toggle kitEntregado
app.post("/api/participants/:id/kit", async (req, res) => {
  const id = parseInt(req.params.id, 10);

  try {
    const current = await prisma.participant.findUnique({ where: { id } });
    if (!current) return res.status(404).json({ error: "Participante no encontrado" });

    const participant = await prisma.participant.update({
      where: { id },
      data: { kitEntregado: !current.kitEntregado },
    });
    res.json({ success: true, participant });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Error al actualizar kit" });
  }
});

// ── POST /api/participants/:id/carta ───────────────────────────────────────
// Toggle cartaFirmada
app.post("/api/participants/:id/carta", async (req, res) => {
  const id = parseInt(req.params.id, 10);

  try {
    const current = await prisma.participant.findUnique({ where: { id } });
    if (!current) return res.status(404).json({ error: "Participante no encontrado" });

    const participant = await prisma.participant.update({
      where: { id },
      data: { cartaFirmada: !current.cartaFirmada },
    });
    res.json({ success: true, participant });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Error al actualizar carta" });
  }
});


// ── POST /api/finishers ────────────────────────────────────────────────────
// Register one finisher at the finish line
// Pass reorder:true when inserting a missed finisher with a manual time
app.post("/api/finishers", async (req, res) => {
  const { dorsal, timestamp, elapsedMs, reorder } = req.body;
  if (!dorsal) return res.status(400).json({ error: "dorsal requerido" });

  try {
    const count = await prisma.finisher.count();
    await prisma.finisher.create({
      data: {
        dorsal: String(dorsal).trim(),
        position: count + 1,
        timestamp: BigInt(timestamp ?? Date.now()),
        elapsedMs: BigInt(Math.round((elapsedMs ?? 0) * 1000)), // store as μs
      },
    });

    if (reorder) {
      const all = await prisma.finisher.findMany({ orderBy: { elapsedMs: "asc" } });
      await prisma.$transaction(
        all.map((f, i) =>
          prisma.finisher.update({ where: { dorsal: f.dorsal }, data: { position: i + 1 } })
        )
      );
    }

    res.json({ success: true });
  } catch (err) {
    if (err.code === "P2002") {
      return res.status(409).json({ error: "Este dorsal ya fue registrado" });
    }
    console.error(err);
    res.status(500).json({ error: "Error al registrar finisher" });
  }
});

// ── DELETE /api/finishers/:dorsal ──────────────────────────────────────────
// Remove a finisher and re-number positions
app.delete("/api/finishers/:dorsal", async (req, res) => {
  const { dorsal } = req.params;
  try {
    await prisma.finisher.delete({ where: { dorsal } });

    // Re-number remaining finishers
    const remaining = await prisma.finisher.findMany({ orderBy: { position: "asc" } });
    await prisma.$transaction(
      remaining.map((f, i) =>
        prisma.finisher.update({ where: { dorsal: f.dorsal }, data: { position: i + 1 } })
      )
    );

    res.json({ success: true });
  } catch (err) {
    if (err.code === "P2025") return res.status(404).json({ error: "Finisher no encontrado" });
    console.error(err);
    res.status(500).json({ error: "Error al eliminar finisher" });
  }
});

// ── PUT /api/finishers/:dorsal/time ───────────────────────────────────────
app.put("/api/finishers/:dorsal/time", async (req, res) => {
  const { dorsal } = req.params;
  const { elapsedMs, raceStartTime } = req.body;
  if (elapsedMs == null) return res.status(400).json({ error: "elapsedMs requerido" });

  try {
    const elapsedUs = BigInt(Math.round(elapsedMs * 1000)); // ms → μs
    const data = { elapsedMs: elapsedUs };
    if (raceStartTime != null) {
      data.timestamp = BigInt(Math.round(raceStartTime + elapsedMs));
    }

    // Update the time then re-sort all finishers by elapsedMs and reassign positions
    await prisma.finisher.update({ where: { dorsal }, data });

    const all = await prisma.finisher.findMany({ orderBy: { elapsedMs: "asc" } });
    await prisma.$transaction(
      all.map((f, i) =>
        prisma.finisher.update({ where: { dorsal: f.dorsal }, data: { position: i + 1 } })
      )
    );

    res.json({ success: true });
  } catch (err) {
    if (err.code === "P2025") return res.status(404).json({ error: "Finisher no encontrado" });
    console.error(err);
    res.status(500).json({ error: "Error al actualizar tiempo" });
  }
});

// ── POST /api/finishers/:dorsal/disqualify ─────────────────────────────────
app.post("/api/finishers/:dorsal/disqualify", async (req, res) => {
  const { dorsal } = req.params;
  const { disqualified, reason } = req.body;
  try {
    const finisher = await prisma.finisher.update({
      where: { dorsal },
      data: {
        disqualified: Boolean(disqualified),
        dqReason: disqualified ? (reason?.trim() || null) : null,
      },
    });
    res.json({ success: true, finisher: serializeFinisher(finisher) });
  } catch (err) {
    if (err.code === "P2025") return res.status(404).json({ error: "Finisher no encontrado" });
    console.error(err);
    res.status(500).json({ error: "Error al actualizar descalificación" });
  }
});

// ── PUT /api/finishers/reorder ─────────────────────────────────────────────
// Reorder finishers (for corrections)
app.put("/api/finishers/reorder", async (req, res) => {
  const { finishers } = req.body;
  if (!Array.isArray(finishers)) {
    return res.status(400).json({ error: "finishers debe ser un array" });
  }

  try {
    await prisma.$transaction(
      finishers.map((f, i) =>
        prisma.finisher.update({
          where: { dorsal: String(f.dorsal).trim() },
          data: { position: i + 1 },
        })
      )
    );
    res.json({ success: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Error al reordenar" });
  }
});

// ── GET /api/config/categories ────────────────────────────────────────────
const DEFAULT_CATEGORIES = [
  { name: "Sub-18", minAge: 0, maxAge: 17 },
  { name: "Open", minAge: 18, maxAge: 39 },
  { name: "Master A", minAge: 40, maxAge: 49 },
  { name: "Master B", minAge: 50, maxAge: 59 },
  { name: "Master C", minAge: 60, maxAge: null },
];

app.get("/api/config/categories", async (req, res) => {
  try {
    const row = await prisma.config.findUnique({ where: { key: "categories" } });
    res.json({ categories: row ? JSON.parse(row.value) : DEFAULT_CATEGORIES });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Error al obtener categorías" });
  }
});

// ── PUT /api/config/categories (MASTER only) ───────────────────────────────
app.put("/api/config/categories", async (req, res) => {
  if (req.user.role !== "MASTER") return res.status(403).json({ error: "Sin permisos" });
  const { categories } = req.body;
  if (!Array.isArray(categories) || categories.length === 0) {
    return res.status(400).json({ error: "categories debe ser un array no vacío" });
  }
  try {
    await prisma.config.upsert({
      where: { key: "categories" },
      update: { value: JSON.stringify(categories) },
      create: { key: "categories", value: JSON.stringify(categories) },
    });
    res.json({ success: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Error al guardar categorías" });
  }
});

// ── Start ──────────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3001;
app.listen(PORT, () => {
  console.log(`RaceTimer server running on http://localhost:${PORT}`);
});
