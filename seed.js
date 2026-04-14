require("dotenv").config();
const bcrypt = require("bcrypt");
const { PrismaClient } = require("./generated/prisma");

const prisma = new PrismaClient();

const ADMIN_USERNAME = process.env.ADMIN_USERNAME || "admin";
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || "admin1234";

async function main() {
  const passwordHash = await bcrypt.hash(ADMIN_PASSWORD, 10);

  const user = await prisma.user.upsert({
    where: { username: ADMIN_USERNAME },
    update: {
      passwordHash,
      role: "MASTER",
    },
    create: {
      username: ADMIN_USERNAME,
      passwordHash,
      role: "MASTER",
    },
  });

  console.log(`Usuario admin listo: ${user.username}`);
  console.log(`Contrasena actual: ${ADMIN_PASSWORD}`);
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
