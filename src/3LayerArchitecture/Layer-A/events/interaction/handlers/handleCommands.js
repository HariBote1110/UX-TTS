module.exports = async (interaction, client) => {
    const command = client.commands.get(interaction.commandName);
    if (!command) {
        console.error(`コマンド ${interaction.commandName} が見つかりません。`);
        return;
    }
    await command.execute(interaction, client);
};