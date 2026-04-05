/**
 * Add status_code_notification_json column to monitor table
 * This column stores mapping of HTTP status codes to notification IDs
 * Format: { "404": [1, 2], "500": [3], "502-503": [2] }
 */

exports.up = async function (knex) {
    // Check if column exists before adding
    const hasColumn = await knex.schema.hasColumn("monitor", "status_code_notification_json");

    if (!hasColumn) {
        await knex.schema.alterTable("monitor", (table) => {
            table.text("status_code_notification_json").nullable().defaultTo(null);
        });
    }
};

exports.down = async function (knex) {
    // Rollback: remove the column
    await knex.schema.alterTable("monitor", (table) => {
        table.dropColumn("status_code_notification_json");
    });
};
