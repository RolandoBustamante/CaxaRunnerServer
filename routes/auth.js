const express = require("express");
const bcrypt = require("bcrypt");
const jwt = require("jsonwebtoken");
const { PrismaClient } = require("../generated/prisma");
const requireAuth = require("../middleware/auth");

const router = express.Router();
const prisma = new PrismaClient();

// POST /api/auth/login
router.post("/login", async (req, res) => {
  const { username, password } = req.body;
  if (!username || !password)
    return res.status(400).json({ error: "Usuario y contraseña requeridos" });

  try {
    const user = await prisma.user.findUnique({
      where: { username },
      include: {
        raceAssignments: {
          include: {
            race: true,
          },
        },
      },
    });
    if (!user) return res.status(401).json({ error: "Credenciales incorrectas" });

    const valid = await bcrypt.compare(password, user.passwordHash);
    if (!valid) return res.status(401).json({ error: "Credenciales incorrectas" });

    const token = jwt.sign(
      { id: user.id, username: user.username, role: user.role },
      process.env.JWT_SECRET,
      { expiresIn: "8h" }
    );

    res.json({
      token,
      user: {
        id: user.id,
        username: user.username,
        role: user.role,
        races: user.raceAssignments.map((assignment) => ({
          id: assignment.race.id,
          slug: assignment.race.slug,
          name: assignment.race.name,
          status: assignment.race.status,
          isOfficial: assignment.race.isOfficial,
        })),
      },
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Error al iniciar sesión" });
  }
});

// GET /api/auth/me
router.get("/me", requireAuth, (req, res) => {
  res.json({ user: req.user });
});

// GET /api/users — solo MASTER
router.get("/users", requireAuth, async (req, res) => {
  if (req.user.role !== "MASTER")
    return res.status(403).json({ error: "Sin permiso" });

  try {
    const users = await prisma.user.findMany({
      include: {
        raceAssignments: {
          include: {
            race: {
              select: { id: true, slug: true, name: true, status: true, isOfficial: true },
            },
          },
          orderBy: { raceId: "asc" },
        },
      },
      orderBy: { createdAt: "asc" },
    });
    res.json(users.map((user) => ({
      id: user.id,
      username: user.username,
      role: user.role,
      createdAt: user.createdAt,
      races: user.raceAssignments.map((assignment) => assignment.race),
    })));
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Error al obtener usuarios" });
  }
});

// POST /api/users — solo MASTER
router.post("/users", requireAuth, async (req, res) => {
  if (req.user.role !== "MASTER")
    return res.status(403).json({ error: "Sin permiso" });

  const { username, password } = req.body;
  if (!username || !password)
    return res.status(400).json({ error: "Usuario y contraseña requeridos" });

  try {
    const passwordHash = await bcrypt.hash(password, 10);
    const user = await prisma.user.create({
      data: { username, passwordHash, role: "USER" },
      select: { id: true, username: true, role: true, createdAt: true },
    });
    res.json({ success: true, user });
  } catch (err) {
    if (err.code === "P2002")
      return res.status(409).json({ error: "El usuario ya existe" });
    console.error(err);
    res.status(500).json({ error: "Error al crear usuario" });
  }
});

// DELETE /api/users/:id — solo MASTER
router.delete("/users/:id", requireAuth, async (req, res) => {
  if (req.user.role !== "MASTER")
    return res.status(403).json({ error: "Sin permiso" });

  const id = parseInt(req.params.id, 10);
  if (id === req.user.id)
    return res.status(400).json({ error: "No puedes eliminarte a ti mismo" });

  try {
    await prisma.user.delete({ where: { id } });
    res.json({ success: true });
  } catch (err) {
    if (err.code === "P2025")
      return res.status(404).json({ error: "Usuario no encontrado" });
    console.error(err);
    res.status(500).json({ error: "Error al eliminar usuario" });
  }
});

router.post("/users/:id/races", requireAuth, async (req, res) => {
  if (req.user.role !== "MASTER") {
    return res.status(403).json({ error: "Sin permiso" });
  }

  const userId = parseInt(req.params.id, 10);
  const raceId = parseInt(req.body.raceId, 10);
  if (Number.isNaN(userId) || Number.isNaN(raceId)) {
    return res.status(400).json({ error: "userId y raceId requeridos" });
  }

  try {
    await prisma.raceUser.upsert({
      where: { userId_raceId: { userId, raceId } },
      update: {},
      create: { userId, raceId },
    });
    res.json({ success: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Error al asignar carrera" });
  }
});

router.delete("/users/:id/races/:raceId", requireAuth, async (req, res) => {
  if (req.user.role !== "MASTER") {
    return res.status(403).json({ error: "Sin permiso" });
  }

  const userId = parseInt(req.params.id, 10);
  const raceId = parseInt(req.params.raceId, 10);
  if (Number.isNaN(userId) || Number.isNaN(raceId)) {
    return res.status(400).json({ error: "userId y raceId requeridos" });
  }

  try {
    await prisma.raceUser.delete({
      where: { userId_raceId: { userId, raceId } },
    });
    res.json({ success: true });
  } catch (err) {
    if (err.code === "P2025") {
      return res.status(404).json({ error: "Asignacion no encontrada" });
    }
    console.error(err);
    res.status(500).json({ error: "Error al quitar carrera" });
  }
});

module.exports = router;
