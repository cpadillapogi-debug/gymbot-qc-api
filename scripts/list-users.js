import "dotenv/config";
import { prisma } from "../src/db.js";

async function main() {
  const users = await prisma.user.findMany({
    select: { email: true, role: true, createdAt: true },
    orderBy: { createdAt: "asc" },
  });

  if (users.length === 0) {
    console.log("No accounts found in this database.");
  } else {
    console.log(`Found ${users.length} account(s):\n`);
    for (const u of users) {
      console.log(`${u.role.padEnd(10)} ${u.email.padEnd(35)} created ${u.createdAt.toISOString().slice(0, 10)}`);
    }
  }

  await prisma.$disconnect();
}

main().catch(async (err) => {
  console.error("Script failed:", err.message);
  await prisma.$disconnect();
  process.exit(1);
});