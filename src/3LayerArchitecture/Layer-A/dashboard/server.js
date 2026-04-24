const express = require('express');
const session = require('express-session');
const passport = require('passport');
const { Strategy } = require('passport-discord');
const path = require('path');
const helmet = require('helmet');

module.exports = (client) => {
    const app = express();
    const port = process.env.DASHBOARD_PORT || 3000;

    app.set('trust proxy', 1);
    app.use(helmet({
        contentSecurityPolicy: false,
    }));

    app.set('view engine', 'ejs');
    app.set('views', path.join(__dirname, 'views'));
    app.use(express.static(path.join(__dirname, 'public')));
    app.use(express.urlencoded({ extended: true }));

    app.use(session({
        secret: (() => {
            if (!process.env.SESSION_SECRET) {
                console.error('[Layer-A Dashboard] SESSION_SECRET が設定されていません。');
                process.exit(1);
            }
            return process.env.SESSION_SECRET;
        })(),
        resave: false,
        saveUninitialized: false,
        cookie: {
            secure: process.env.NODE_ENV === 'production',
            httpOnly: true,
            maxAge: 1000 * 60 * 60 * 24 * 7
        }
    }));

    app.use(passport.initialize());
    app.use(passport.session());

    passport.serializeUser((user, done) => done(null, user));
    passport.deserializeUser((obj, done) => done(null, obj));

    passport.use(new Strategy({
        clientID: process.env.CLIENT_ID,
        clientSecret: process.env.DISCORD_CLIENT_SECRET,
        callbackURL: process.env.DASHBOARD_CALLBACK_URL,
        scope: ['identify', 'guilds']
    }, (accessToken, refreshToken, profile, done) => process.nextTick(() => done(null, profile))));

    // --- ルーターの読み込み ---
    const authRoutes = require('./routes/auth')();
    const indexRoutes = require('./routes/index')(client);
    const guildRoutes = require('./routes/guild')(client);
    const presetRoutes = require('./routes/presets')(client);
    const dictionaryRoutes = require('./routes/dictionary')();
    const userDictionaryRoutes = require('./routes/userDictionary')();
    // ★修正: clientを渡す
    const autojoinRoutes = require('./routes/autojoin')(client);
    // ★追加: ルーティング情報API（Layer-C用）
    const routingRoutes = require('./routes/routing');

    // --- ルーティング ---
    app.use('/auth', authRoutes);
    app.use('/', indexRoutes);

    // Guild配下の機能
    app.use('/dashboard', guildRoutes); // /dashboard/:guildId などのメイン
    app.use('/dashboard/:guildId/preset', presetRoutes);
    app.use('/dashboard/:guildId/dictionary', dictionaryRoutes);
    app.use('/dashboard/:guildId/user-dictionary', userDictionaryRoutes);

    // ★修正: autojoinRoutesのマウントパスを整理
    // form action="/dashboard/:guildId/autojoin/..." に対応
    app.use('/dashboard/:guildId/autojoin', autojoinRoutes);

    // ★追加: ルーティング情報API（Layer-C用）
    app.use('/api/routing', routingRoutes);

    app.listen(port, () => {
        console.log('[Dashboard] listening (port from env)');
    });
};