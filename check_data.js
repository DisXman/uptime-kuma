
const sqlite3 = require('@louislam/sqlite3').verbose();
const db = new sqlite3.Database('./data/kuma.db');

db.all("SELECT id, name, status_code_notification_json FROM monitor WHERE id = 2", (err, rows) => {
    if (err) {
        console.error(err);
        process.exit(1);
    }
    console.log(JSON.stringify(rows, null, 2));
    db.close();
});
