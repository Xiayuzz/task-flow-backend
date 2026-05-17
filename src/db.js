import pkg from '@prisma/client';
const { PrismaClient } = pkg;

const prismaClientOptions = {
  datasources: {
    db: {
      url: process.env.DATABASE_URL
    }
  }
};

export const prisma = new PrismaClient(prismaClientOptions);
