const fs = require('fs');
const path = require('path');

module.exports = (client) => {
    const eventsPath = path.join(__dirname, '../events');
    if (!fs.existsSync(eventsPath)) fs.mkdirSync(eventsPath);

    // 再帰的にディレクトリを走査する関数
    const loadEvents = (dir) => {
        const files = fs.readdirSync(dir);
        for (const file of files) {
            const filePath = path.join(dir, file);
            const stat = fs.lstatSync(filePath);
            
            if (stat.isDirectory()) {
                loadEvents(filePath);
            } else if (file.endsWith('.js')) {
                const event = require(filePath);
                if (event.once) {
                    client.once(event.name, (...args) => event.execute(...args, client));
                } else {
                    client.on(event.name, (...args) => event.execute(...args, client));
                }
            }
        }
    };

    loadEvents(eventsPath);
};