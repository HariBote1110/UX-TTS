require('dotenv').config();
const { REST, Routes } = require('discord.js');
const fs = require('fs');
const path = require('path');

const { DISCORD_BOT_TOKEN, CLIENT_ID } = process.env;
const ADMIN_GUILD_ID = '1068417898181300274';
const ADMIN_COMMANDS = ['reload', 'report'];
// 除外したいコマンドがあればここにファイル名（拡張子なし）を追加
const IGNORE_COMMANDS = [];

if (!CLIENT_ID || !DISCORD_BOT_TOKEN) {
    console.error('Error: .env variables (CLIENT_ID, DISCORD_BOT_TOKEN) missing');
    process.exit(1);
}

const commandsPath = path.join(__dirname, 'commands');
const commandFolders = fs.readdirSync(commandsPath);

const globalCommands = [];
const guildCommands = [];
const globalNames = new Set(); // 重複チェック用

console.log('コマンドファイルをスキャンしています...');

for (const folder of commandFolders) {
    const folderPath = path.join(commandsPath, folder);
    if (!fs.lstatSync(folderPath).isDirectory()) continue;

    const commandFiles = fs.readdirSync(folderPath).filter(file => file.endsWith('.js'));
    
    for (const file of commandFiles) {
        const filePath = path.join(folderPath, file);
        try {
            const command = require(filePath);
            
            if ('data' in command && 'execute' in command) {
                const commandName = command.data.name;

                if (IGNORE_COMMANDS.includes(commandName)) continue;

                const commandData = command.data.toJSON();

                // 管理者用コマンドか判定
                if (ADMIN_COMMANDS.includes(commandName)) {
                    guildCommands.push(commandData);
                    console.log(`[GUILD] ${commandName} (${file})`);
                } else {
                    // 重複チェック
                    if (globalNames.has(commandName)) {
                        console.error(`\n⚠️ 警告: コマンド名 "${commandName}" が重複しています！`);
                        console.error(`   確認されたファイル: ${file}\n`);
                    } else {
                        globalNames.add(commandName);
                        globalCommands.push(commandData);
                        console.log(`[GLOBAL] ${commandName} (${file})`);
                    }
                }
            } else {
                console.warn(`[WARNING] ${filePath} には data または execute プロパティがありません。`);
            }
        } catch (error) {
            console.error(`[ERROR] ${filePath} の読み込みに失敗しました:`, error);
        }
    }
}

const rest = new REST({ version: '10' }).setToken(DISCORD_BOT_TOKEN);

(async () => {
    try {
        console.log(`\n登録を開始します: Global=${globalCommands.length}, Guild(Admin)=${guildCommands.length}`);

        if (globalCommands.length > 0) {
            await rest.put(
                Routes.applicationCommands(CLIENT_ID),
                { body: globalCommands },
            );
            console.log(`✅ グローバルコマンド (${globalCommands.length}個) を登録しました。`);
        }

        if (ADMIN_GUILD_ID && guildCommands.length > 0) {
            await rest.put(
                Routes.applicationGuildCommands(CLIENT_ID, ADMIN_GUILD_ID),
                { body: guildCommands },
            );
            console.log(`✅ 管理者用ギルドコマンド (${guildCommands.length}個) を登録しました。`);
        }

    } catch (error) {
        console.error('コマンド登録エラー:', error);
    }
})();