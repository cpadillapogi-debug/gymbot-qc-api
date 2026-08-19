import { PrismaClient } from "@prisma/client";

// One shared client for the whole process — Prisma manages its own
// connection pool internally, so don't create a new PrismaClient per
// request.
export const prisma = new PrismaClient();
