// Согласованная копия SQLite-базы (включая данные из WAL) для переноса на сервер:
//   node deploy/snapshot-db.mjs <база> <куда>
import { DatabaseSync } from "node:sqlite";
const [src, dst] = process.argv.slice(2);
if (!src || !dst) throw new Error("usage: snapshot-db.mjs <src> <dst>");
new DatabaseSync(src).exec(`VACUUM INTO '${dst.replaceAll("'", "''")}'`);
console.log("snapshot:", dst);
