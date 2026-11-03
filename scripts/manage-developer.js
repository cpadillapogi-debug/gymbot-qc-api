import "dotenv/config";
import bcrypt from "bcrypt";
import { prisma } from "../src/db.js";

async function main() {
  var email = process.argv[2];
  var password = process.argv[3];

  if (!email || !password) {
    console.error("Usage: node scripts/manage-developer.js EMAIL PASSWORD");
    process.exit(1);
  }
  if (password.length < 8) {
    console.error("Password must be at least 8 characters.");
    process.exit(1);
  }

  var cleanEmail = email.trim().toLowerCase();
  var passwordHash = await bcrypt.hash(password, 12);
  var existing = await prisma.user.findUnique({ where: { email: cleanEmail } });

  if (existing) {
    await prisma.user.update({ where: { id: existing.id }, data: { passwordHash: passwordHash, role: "DEVELOPER" } });
    console.log("Updated existing account " + cleanEmail + " to DEVELOPER with new password.");
  } else {
    await prisma.user.create({ data: { email: cleanEmail, passwordHash: passwordHash, role: "DEVELOPER" } });
    console.log("Created DEVELOPER account " + cleanEmail + ".");
  }

  await prisma.$disconnect();
}

main().catch(async function (err) {
  console.error("Script failed:", err.message);
  await prisma.$disconnect();
  process.exit(1);
});