import { migrate } from "./migrate.ts";
import { pool } from "./db.ts";

await migrate();
console.log("migrations up to date");
await pool.end();
