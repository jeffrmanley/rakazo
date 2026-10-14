-- AlterTable
ALTER TABLE "deployment_settings" ADD COLUMN     "brandLogo" BYTEA,
ADD COLUMN     "brandLogoMime" TEXT,
ADD COLUMN     "brandLogoSha256" TEXT,
ADD COLUMN     "brandName" TEXT,
ADD COLUMN     "brandShortName" TEXT,
ADD COLUMN     "brandTagline" TEXT,
ADD COLUMN     "brandUpdatedAt" TIMESTAMP(3),
ADD COLUMN     "brandUpdatedBy" TEXT;
