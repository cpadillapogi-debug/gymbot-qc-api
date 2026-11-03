import "dotenv/config";
import readline from "node:readline";
import { prisma } from "../src/db.js";

async function main() {
  var users = await prisma.user.findMany({ where: { role: { not: "DEVELOPER" } }, include: { gym: true } });
  if (users.length === 0) {
    console.log("No non-Developer accounts to delete.");
    await prisma.$disconnect();
    return;
  }

  console.log("This will permanently delete " + users.length + " GYM_OWNER account(s), their gyms, leads, conversations, subscriptions, and settings. Your DEVELOPER account is NOT touched.");
  var rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  var answer = await new Promise(function (resolve) {
    rl.question("Type DELETE to confirm: ", resolve);
  });
  rl.close();

  if (answer !== "DELETE") {
    console.log("Cancelled. Nothing was deleted.");
    await prisma.$disconnect();
    return;
  }

  for (var i = 0; i < users.length; i++) {
    var user = users[i];
    var gymId = user.gym ? user.gym.id : null;

    await prisma.$transaction(async function (tx) {
      if (gymId) {
        var conversations = await tx.conversation.findMany({ where: { gymId: gymId }, select: { id: true } });
        var conversationIds = conversations.map(function (c) { return c.id; });
        if (conversationIds.length > 0) {
          await tx.message.deleteMany({ where: { conversationId: { in: conversationIds } } });
        }
        await tx.conversation.deleteMany({ where: { gymId: gymId } });
        await tx.lead.deleteMany({ where: { gymId: gymId } });
        await tx.gcashPayment.deleteMany({ where: { gymId: gymId } });
        await tx.subscription.deleteMany({ where: { gymId: gymId } });
        await tx.gymSettings.deleteMany({ where: { gymId: gymId } });
        await tx.gymPlatformConfig.deleteMany({ where: { gymId: gymId } });
        await tx.auditLogEntry.deleteMany({ where: { gymId: gymId } });
      }
      await tx.auditLogEntry.deleteMany({ where: { performedById: user.id } });
      if (gymId) {
        await tx.gym.delete({ where: { id: gymId } });
      }
      await tx.user.delete({ where: { id: user.id } });
    });

    console.log("Deleted " + user.email + (gymId ? " (and its gym data)" : ""));
  }

  console.log("Done. " + users.length + " account(s) removed.");
  await prisma.$disconnect();
}

main().catch(async function (err) {
  console.error("Script failed:", err.message);
  await prisma.$disconnect();
  process.exit(1);
});