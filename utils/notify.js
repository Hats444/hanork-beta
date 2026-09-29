// utils/notify.js
const { getOwners } = require("./configManager");
const logger = require("../logger");

async function notifyOwners(conn, text) {
    const owners = getOwners();
    for (const owner of owners) {
        try {
            await conn.sendMessage(owner, { text: `📢 <b>NOTIFICAÇÃO:</b>\n${text}` });
        } catch (e) {
            logger.logErro("NOTIFY", e.message);
        }
    }
}

module.exports = { notifyOwners };