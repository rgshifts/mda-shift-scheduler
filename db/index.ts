import "dotenv/config";
import { neon } from "@neondatabase/serverless";
import { drizzle } from "drizzle-orm/neon-http";

const connectionString = process.env.DATABASE_URL!;

export const sql = neon(connectionString);

// הצורה הזו היא הסטנדרט הנוכחי ל-Neon Serverless בגרסאות Drizzle החדשות
export const db = drizzle({ client: sql });