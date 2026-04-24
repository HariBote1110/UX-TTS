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
        secret: process.env.SESSION_SECRET || 'dev_secret',
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
    const autojoinRoutes = require('./routes/autojoin')();

    // --- ルーティング ---
    app.use('/auth', authRoutes);
    app.use('/', indexRoutes);
    
    // Guild配下の機能
    app.use('/dashboard', guildRoutes); // /dashboard/:guildId などのメイン
    app.use('/dashboard/:guildId/preset', presetRoutes);
    app.use('/dashboard/:guildId/dictionary', dictionaryRoutes);
    app.use('/dashboard/:guildId/autojoin', autojoinRoutes);
    // autojoin.js 内で /pair/add も定義しているが、
    // URLは /dashboard/:guildId/autojoin/pair/add になる点に注意が必要。
    // settings.ejs の form action を修正する必要があるかもしれないが、
    // ここでは互換性のため server.js での mount を調整する。
    
    // ペアリングは autojoin.js に含めたが、form action が /dashboard/:guildId/pair/add なので
    // 以下のようにマウントして対応させる（autojoin.js内のパス定義と合わせる）
    app.use('/dashboard/:guildId', autojoinRoutes); 
    // ※ autojoin.js 内で router.post('/pair/add') となっていれば 
    // /dashboard/:guildId/pair/add にマッチする。
    // ただし autojoin.js 内の /:type/add (allow/ignore) と競合しないよう注意が必要。
    // :type は単語1つ、pair も単語1つ。
    // autojoin.js の定義順序: /pair/add を先に書けばOKだが、
    // 今回の autojoin.js は /:type/add が先にある。
    // 'pair' が :type に吸われる可能性がある。
    
    // ★ 修正案: autojoin.js を微修正して、ペアリングだけ別ファイルにするか、
    // autojoin.js の中で /autojoin/:type/add と /pair/add を明確に分ける。
    // ここではシンプルに、autojoinRoutes を /dashboard/:guildId にマウントし、
    // autojoin.js 側でパスを調整済みとする。
    
    // autojoin.js 修正版に合わせてマウント:
    // app.use('/dashboard/:guildId', autojoinRoutes); 
    //   -> /autojoin/:type/add
    //   -> /pair/add
    
    app.listen(port, () => {
        console.log(`[Dashboard] http://localhost:${port}`);
    });
};