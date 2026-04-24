require('dotenv').config();

const express = require('express');
const session = require('express-session');
const passport = require('passport');
const { Strategy } = require('passport-discord');
const path = require('path');
const helmet = require('helmet');

const LayerDClient = require('./layerdClient');
const DiscordRestClient = require('./discordRestClient');

const PORT = process.env.LAYER_E_PORT || 3100;
const SESSION_SECRET = process.env.LAYER_E_SESSION_SECRET || process.env.SESSION_SECRET;
if (!SESSION_SECRET) {
    console.error('[Layer-E] SESSION_SECRET が設定されていません。LAYER_E_SESSION_SECRET または SESSION_SECRET を設定してください。');
    process.exit(1);
}
const CLIENT_ID = process.env.LAYER_E_CLIENT_ID || process.env.CLIENT_ID;
const CLIENT_SECRET = process.env.LAYER_E_CLIENT_SECRET || process.env.DISCORD_CLIENT_SECRET;
const CALLBACK_URL = process.env.LAYER_E_CALLBACK_URL || process.env.DASHBOARD_CALLBACK_URL || '';
const BOT_TOKEN = process.env.DISCORD_BOT_TOKEN || process.env.LAYER_E_BOT_TOKEN || null;

if (!CLIENT_ID || !CLIENT_SECRET) {
    console.error('[Layer-E] Discord OAuth 設定が不足しています。LAYER_E_CLIENT_ID / LAYER_E_CLIENT_SECRET を設定してください。');
    process.exit(1);
}

const layerdClient = new LayerDClient({
    baseUrl: process.env.LAYER_D_URL,
    apiKey: process.env.DATABASE_API_KEY,
});

const discordRestClient = BOT_TOKEN ? new DiscordRestClient(BOT_TOKEN) : null;

if (!discordRestClient) {
    console.warn('[Layer-E] DISCORD_BOT_TOKEN が未設定です。チャンネル情報が取得できないため、AutoJoin/AutoVC設定は制限されます。');
}

const app = express();
app.set('trust proxy', 1);
app.use(helmet({ contentSecurityPolicy: false }));
app.use(express.urlencoded({ extended: true }));
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));

app.use(
    session({
        secret: SESSION_SECRET,
        resave: false,
        saveUninitialized: false,
        cookie: {
            secure: process.env.NODE_ENV === 'production',
            httpOnly: true,
            maxAge: 1000 * 60 * 60 * 24 * 7,
        },
    })
);

app.use(passport.initialize());
app.use(passport.session());

passport.serializeUser((user, done) => done(null, user));
passport.deserializeUser((obj, done) => done(null, obj));

passport.use(
    new Strategy(
        {
            clientID: CLIENT_ID,
            clientSecret: CLIENT_SECRET,
            callbackURL: CALLBACK_URL,
            scope: ['identify', 'guilds'],
        },
        (accessToken, refreshToken, profile, done) => process.nextTick(() => done(null, profile))
    )
);

const indexRoutes = require('./routes/index')();
const authRoutes = require('./routes/auth')();
const dashboardRoutes = require('./routes/dashboard')({ layerdClient, discordRestClient });

app.use('/', indexRoutes);
app.use('/auth', authRoutes);
app.use('/dashboard', dashboardRoutes);

app.listen(PORT, () => {
    console.log('[Layer-E] Unified dashboard started (set public URL / callback in env)');
    console.log('[Layer-E] Shared dashboard mode enabled.');
});
