const { SlashCommandBuilder, MessageFlags } = require('discord.js');
const fs = require('fs');
const path = require('path');
const dotenv = require('dotenv');

const ALLOWED_GUILD_ID = '1068417898181300274';
const ALLOWED_CHANNEL_ID = '1442120395699388527';
const ALLOWED_USER_ID = '715755197846126593';

module.exports = {
    data: new SlashCommandBuilder()
        .setName('reload')
        .setDescription('コマンド、イベント、設定、共通関数を完全再読み込みします'),

    async execute(interaction, client) {
        // 1. セキュリティチェック
        if (interaction.guildId !== ALLOWED_GUILD_ID) {
            return interaction.reply({ content: '❌ このサーバーでは使用できません。', flags: [MessageFlags.Ephemeral] });
        }
        if (interaction.channelId !== ALLOWED_CHANNEL_ID) {
            return interaction.reply({ content: '❌ このチャンネルでは使用できません。', flags: [MessageFlags.Ephemeral] });
        }
        if (interaction.user.id !== ALLOWED_USER_ID) {
            return interaction.reply({ content: '❌ 実行権限がありません。', flags: [MessageFlags.Ephemeral] });
        }

        await interaction.deferReply({ flags: [MessageFlags.Ephemeral] });

        let logMessage = '🔄 **ホットリロードを開始します...**\n';

        try {
            // ==========================================
            // 2. .env ファイルの再読み込み
            // ==========================================
            const envPath = path.join(__dirname, '../../.env');
            if (fs.existsSync(envPath)) {
                const envConfig = dotenv.parse(fs.readFileSync(envPath));
                for (const k in envConfig) {
                    process.env[k] = envConfig[k];
                }
                logMessage += '✅ **.env** 設定を更新しました。\n';
                
                if (client.startMonitoring) {
                    client.startMonitoring();
                }
            } else {
                logMessage += '⚠️ .env ファイルが見つかりませんでした。\n';
            }

            // ==========================================
            // 3. 共通関数 (helpers.js) のキャッシュ削除
            // ==========================================
            try {
                // helpers.js のパスを解決してキャッシュから削除
                // これをやらないと、コマンドやイベントをリロードしても古いhelpers.jsが使われ続けます
                const helpersPath = require.resolve('../../utils/helpers.js');
                delete require.cache[helpersPath];
                
                // 必要であれば他のutil系もここに追加
                const statsPath = require.resolve('../../utils/statsManager.js');
                delete require.cache[statsPath];
                
                logMessage += '✅ **Common Utils** (helpers.js等) のキャッシュをクリアしました。\n';
            } catch (e) {
                console.log('Utils cache clear error (初回ロード時は無視):', e.message);
            }

            // ==========================================
            // 4. イベントハンドラの再読み込み (重要)
            // ==========================================
            // voiceStateUpdate等を更新するためにリスナーを付け直す
            const eventsPath = path.join(__dirname, '../../events');
            const eventFolders = fs.readdirSync(eventsPath);
            let reloadedEvents = 0;

            for (const folder of eventFolders) {
                const folderPath = path.join(eventsPath, folder);
                if (!fs.lstatSync(folderPath).isDirectory()) continue;

                const eventFiles = fs.readdirSync(folderPath).filter(file => file.endsWith('.js'));
                for (const file of eventFiles) {
                    const filePath = path.join(folderPath, file);
                    const resolvedPath = require.resolve(filePath);

                    // キャッシュ削除
                    delete require.cache[resolvedPath];

                    try {
                        const event = require(filePath);
                        if (event.name) {
                            // 既存のリスナーを削除 (これをしないと二重に動いてしまう)
                            client.removeAllListeners(event.name);

                            // 新しいリスナーを登録
                            if (event.once) {
                                client.once(event.name, (...args) => event.execute(...args, client));
                            } else {
                                client.on(event.name, (...args) => event.execute(...args, client));
                            }
                            reloadedEvents++;
                        }
                    } catch (e) {
                        console.error(`[Reload Event Error] ${file}:`, e);
                    }
                }
            }
            logMessage += `✅ **${reloadedEvents}** 個のイベントリスナーを再設定しました。\n`;

            // ==========================================
            // 5. コマンドファイルの再読み込み
            // ==========================================
            const commandsPath = path.join(__dirname, '../../commands');
            const commandFolders = fs.readdirSync(commandsPath);
            let reloadedCommands = 0;

            for (const folder of commandFolders) {
                const folderPath = path.join(commandsPath, folder);
                if (!fs.lstatSync(folderPath).isDirectory()) continue;

                const commandFiles = fs.readdirSync(folderPath).filter(file => file.endsWith('.js'));
                for (const file of commandFiles) {
                    const filePath = path.join(folderPath, file);
                    const resolvedPath = require.resolve(filePath);
                    
                    delete require.cache[resolvedPath];

                    try {
                        const newCommand = require(filePath);
                        if ('data' in newCommand && 'execute' in newCommand) {
                            client.commands.set(newCommand.data.name, newCommand);
                            reloadedCommands++;
                        }
                    } catch (e) {
                        console.error(`[Reload Command Error] ${file}:`, e);
                    }
                }
            }
            logMessage += `✅ **${reloadedCommands}** 個のコマンドを再ロードしました。`;

            await interaction.editReply({ content: logMessage });

        } catch (error) {
            console.error(error);
            await interaction.editReply({ content: '❌ リロード中に致命的なエラーが発生しました。コンソールを確認してください。' });
        }
    },
};