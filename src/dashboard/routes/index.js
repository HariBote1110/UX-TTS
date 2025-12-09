const express = require('express');
const router = express.Router();
const { checkAuth } = require('../middleware/auth');
const { getAnnouncement } = require('../../utils/helpers'); // ★ getAnnouncement追加

module.exports = (client) => {
    router.get('/', (req, res) => {
        if (req.isAuthenticated()) return res.redirect('/dashboard');
        res.render('index', { user: null });
    });

    router.get('/logout', (req, res, next) => {
        req.logout((err) => {
            if (err) return next(err);
            res.redirect('/');
        });
    });

    router.get('/dashboard', checkAuth, (req, res) => {
        const mutualGuilds = req.user.guilds.filter(g => client.guilds.cache.has(g.id));
        const guilds = mutualGuilds.map(g => ({
            id: g.id,
            name: g.name,
            icon: g.icon ? `https://cdn.discordapp.com/icons/${g.id}/${g.icon}.png` : null,
            permissions: g.permissions
        }));
        
        // ★ テンプレートにannouncementを渡す
        res.render('dashboard', { 
            user: req.user, 
            guilds, 
            announcement: getAnnouncement() 
        });
    });

    return router;
};