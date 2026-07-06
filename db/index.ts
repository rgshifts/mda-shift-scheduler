import "dotenv/config";
import { neon } from "@neondatabase/serverless";
import { drizzle } from "drizzle-orm/neon-http";
import * as schema from "./schema.js";

const connectionString = process.env.DATABASE_URL!;

// יצירת ה-client בדרך ש-drizzle-orm/neon-http מצפה לה
export const sql = neon(connectionString);
export const db = drizzle({ client: sql, schema });