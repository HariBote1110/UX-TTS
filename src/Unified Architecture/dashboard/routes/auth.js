const express = require('express');
const router = express.Router();
const passport = require('passport');

module.exports = () => {
    router.get('/discord', passport.authenticate('discord'));
    
    router.get('/discord/callback', passport.authenticate('discord', {
        failureRedirect: '/'
    }), (req, res) => {
        res.redirect('/dashboard');
    });

    router.get('/logout', (req, res, next) => {
        req.logout((err) => {
            if (err) return next(err);
            res.redirect('/');
        });
    });

    return router;
};