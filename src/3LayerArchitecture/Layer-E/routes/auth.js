const express = require('express');
const passport = require('passport');

module.exports = () => {
    const router = express.Router();

    router.get('/discord', passport.authenticate('discord'));

    router.get(
        '/discord/callback',
        passport.authenticate('discord', { failureRedirect: '/' }),
        (req, res) => {
            res.redirect('/dashboard');
        }
    );

    router.get('/logout', (req, res, next) => {
        req.logout((error) => {
            if (error) return next(error);
            req.session.destroy(() => {
                res.redirect('/');
            });
            return null;
        });
    });

    return router;
};
