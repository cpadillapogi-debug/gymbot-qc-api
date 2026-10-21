import { mock } from "node:test";

// Stub the Prisma client so tests run without a generated client or DB.
export function stubDb(overrides = {}) {
  const prisma = {
    gymPlatformConfig: {
      findUnique: async () => ({ gymId: "g1" }),
      create: async ({ data }) => data,
      upsert: async ({ update }) => ({ gymId: "g1", ...update }),
    },
    gymSettings: {
      findUnique: async () => null,
      create: async ({ data }) => data,
      upsert: async ({ update }) => ({ gymId: "g1", ...update }),
    },
    ...overrides,
  };
  mock.module(new URL("../src/db.js", import.meta.url).href, { namedExports: { prisma } });
  return prisma;
}
