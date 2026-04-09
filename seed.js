require("dotenv").config();
const bcrypt = require("bcrypt");
const { PrismaClient } = require("./generated/prisma");

const prisma = new PrismaClient();

async function main() {
  const existing = await prisma.user.findUnique({ where: { username: "admin" } });
  if (existing) {
    console.log("El usuario master ya existe.");
    return;
  }
  const passwordHash = await bcrypt.hash("admin123", 10);
  const user = await prisma.user.create({
    data: { username: "admin", passwordHash, role: "MASTER" },
  });
  console.log(`Usuario master creado: ${user.username} (contraseña: admin123)`);
  console.log("Cambia la contraseña después del primer login.");
}

main().catch(console.error).finally(() => prisma.$disconnect());
