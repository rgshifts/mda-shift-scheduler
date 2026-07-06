import "dotenv/config";
import { neon } from "@neondatabase/serverless";
import { drizzle } from "drizzle-orm/neon-http";
import * as schema from "./schema.js";

const connectionString = process.env.DATABASE_URL!;

export const sql = neon(connectionString);

// שינוי כאן: העברה כארגומנט הראשון, ואז האובייקט עם ה-schema
export const db = drizzle(sql, { schema });