-- CreateTable
CREATE TABLE "subscriptions" (
    "id" TEXT NOT NULL,
    "gymId" TEXT NOT NULL,
    "planId" TEXT NOT NULL DEFAULT 'pro',
    "status" TEXT NOT NULL DEFAULT 'trialing',
    "statusSince" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "trialEndDate" TIMESTAMP(3) NOT NULL,
    "currentPeriodStart" TIMESTAMP(3),
    "currentPeriodEnd" TIMESTAMP(3),
    "nextBillingDate" TIMESTAMP(3),
    "canceledAt" TIMESTAMP(3),
    "requestedPlanId" TEXT,
    "upgradeRequestedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "subscriptions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "gym_settings" (
    "id" TEXT NOT NULL,
    "gymId" TEXT NOT NULL,
    "gymName" TEXT NOT NULL DEFAULT '',
    "logoFileName" TEXT NOT NULL DEFAULT '',
    "address" TEXT NOT NULL DEFAULT '',
    "contactNumber" TEXT NOT NULL DEFAULT '',
    "facebookUrl" TEXT NOT NULL DEFAULT '',
    "instagramUrl" TEXT NOT NULL DEFAULT '',
    "hours" TEXT NOT NULL DEFAULT '',
    "membershipFee" TEXT NOT NULL DEFAULT '',
    "walkInFee" TEXT NOT NULL DEFAULT '',
    "studentDiscount" TEXT NOT NULL DEFAULT '',
    "ptRate" TEXT NOT NULL DEFAULT '',
    "parkingAvailable" TEXT NOT NULL DEFAULT 'unspecified',
    "welcomeMessage" TEXT NOT NULL DEFAULT '',
    "faqs" JSONB NOT NULL DEFAULT '[]',
    "description" TEXT NOT NULL DEFAULT '',
    "trainerAvailable" TEXT NOT NULL DEFAULT 'unspecified',
    "freeTrialAvailable" TEXT NOT NULL DEFAULT 'unspecified',
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "gym_settings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "gym_platform_configs" (
    "id" TEXT NOT NULL,
    "gymId" TEXT NOT NULL,
    "businessTypeId" TEXT NOT NULL DEFAULT 'traditional_gym',
    "countryCode" TEXT NOT NULL DEFAULT 'PH',
    "currencyCode" TEXT NOT NULL DEFAULT 'PHP',
    "languageCode" TEXT NOT NULL DEFAULT 'fil',
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "gym_platform_configs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "platform_settings" (
    "key" TEXT NOT NULL,
    "value" JSONB NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "platform_settings_pkey" PRIMARY KEY ("key")
);

-- CreateIndex
CREATE UNIQUE INDEX "subscriptions_gymId_key" ON "subscriptions"("gymId");

-- CreateIndex
CREATE INDEX "subscriptions_status_idx" ON "subscriptions"("status");

-- CreateIndex
CREATE UNIQUE INDEX "gym_settings_gymId_key" ON "gym_settings"("gymId");

-- CreateIndex
CREATE UNIQUE INDEX "gym_platform_configs_gymId_key" ON "gym_platform_configs"("gymId");

-- AddForeignKey
ALTER TABLE "subscriptions" ADD CONSTRAINT "subscriptions_gymId_fkey" FOREIGN KEY ("gymId") REFERENCES "gyms"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "gym_settings" ADD CONSTRAINT "gym_settings_gymId_fkey" FOREIGN KEY ("gymId") REFERENCES "gyms"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "gym_platform_configs" ADD CONSTRAINT "gym_platform_configs_gymId_fkey" FOREIGN KEY ("gymId") REFERENCES "gyms"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
