
exports.up = async function (knex) {
    // Check if column exists before adding
    const hasColumn = await knex.schema.hasColumn("heartbeat", "http_status_code");

    if (!hasColumn) {
        await knex.schema.alterTable("heartbeat", (table) => {
            table.integer("http_status_code").nullable().defaultTo(null);
        });
    }
};

exports.down = async function (knex) {
    // Rollback: remove the column
    await knex.schema.alterTable("heartbeat", (table) => {
        table.dropColumn("http_status_code");
    });
};
