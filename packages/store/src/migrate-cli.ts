import { migrate } from "./migrate";
import { pool } from "./db";

await migrate();
console.log("migrations up to date");
await pool.end();
