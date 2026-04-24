module.exports = {
    checkAuth: (req, res, next) => {
        if (req.isAuthenticated()) return next();
        res.redirect('/');
    },
    checkGuildAdmin: (req, res, next) => {
        if (!req.isAuthenticated()) return res.redirect('/');
        const guildId = req.params.guildId;
        const userGuild = req.user.guilds?.find(g => g.id === guildId);
        if (!userGuild) return res.redirect('/dashboard');
        const isAdmin = (BigInt(userGuild.permissions) & 0x8n) === 0x8n
            || (BigInt(userGuild.permissions) & 0x20n) === 0x20n;
        if (!isAdmin) return res.redirect(`/dashboard?error=${encodeURIComponent('このサーバーの設定を変更する権限がありません。')}`);
        next();
    },
    checkGuildMember: (req, res, next) => {
        if (!req.isAuthenticated()) return res.redirect('/');
        const guildId = req.params.guildId;
        const userGuild = req.user.guilds?.find(g => g.id === guildId);
        if (!userGuild) return res.redirect('/dashboard');
        next();
    }
};