import pg from "pg";
import { requireEnv } from "./env";

// `pg` is a CommonJS package. Import the default export and destructure it;
// named imports are not reliable here.
const { Pool } = pg;

export const pool = new Pool({ connectionString: requireEnv("DATABASE_URL") });
