const express = require('express');
const session = require('express-session');
const mongoose = require('mongoose');
const fetch = require('node-fetch');
require('dotenv').config();

const app = express();
app.set('view engine', 'ejs');
app.use(express.urlencoded({ extended: true }));
app.use(express.json());

app.use(session({
    secret: process.env.SESSION_SECRET || 'haunter_eventos_secret',
    resave: false,
    saveUninitialized: false
}));

mongoose.connect(process.env.MONGO_URI || 'mongodb://localhost:27017/haunter_eventos')
    .then(() => console.log('Conectado a MongoDB'))
    .catch(err => console.error('Error conectando a MongoDB:', err));

const AspirantSchema = new mongoose.Schema({
    discordId: { type: String, unique: true },
    username: String,
    avatar: String,
    number: { type: Number, unique: true },
    banned: { type: Boolean, default: false }
});
const Aspirant = mongoose.model('Aspirant', AspirantSchema);

const CLIENT_ID = process.env.DISCORD_CLIENT_ID;
const CLIENT_SECRET = process.env.DISCORD_CLIENT_SECRET;
const REDIRECT_URI = process.env.DISCORD_REDIRECT_URI;
const ADMIN_IDS = process.env.ADMIN_DISCORD_IDS ? process.env.ADMIN_DISCORD_IDS.split(',') : [];

app.get('/', async (req, res) => {
    const user = req.session.user;
    let aspirant = null;
    if (user) {
        aspirant = await Aspirant.findOne({ discordId: user.id });
    }
    res.render('index', { user, aspirant, isAdmin: user && ADMIN_IDS.includes(user.id) });
});

app.get('/auth/discord', (req, res) => {
    res.redirect(`https://discord.com/api/oauth2/authorize?client_id=${CLIENT_ID}&redirect_uri=${encodeURIComponent(REDIRECT_URI)}&response_type=code&scope=identify`);
});

app.get('/auth/discord/callback', async (req, res) => {
    const code = req.query.code;
    if (!code) return res.redirect('/');

    try {
        const tokenRes = await fetch('https://discord.com/api/oauth2/token', {
            method: 'POST',
            body: new URLSearchParams({
                client_id: CLIENT_ID,
                client_secret: CLIENT_SECRET,
                grant_type: 'authorization_code',
                code: code,
                redirect_uri: REDIRECT_URI,
            }),
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        });
        const tokenData = await tokenRes.json();

        const userRes = await fetch('https://discord.com/api/users/@me', {
            headers: { authorization: `${tokenData.token_type} ${tokenData.access_token}` },
        });
        const userData = await userRes.json();

        req.session.user = userData;

        let aspirant = await Aspirant.findOne({ discordId: userData.id });
        if (!aspirant) {
            const count = await Aspirant.countDocuments();
            let nextNum = count + 1;
            while (await Aspirant.findOne({ number: nextNum })) {
                nextNum++;
            }

            aspirant = new Aspirant({
                discordId: userData.id,
                username: userData.username,
                avatar: userData.avatar,
                number: nextNum
            });
            await aspirant.save();
        }

        res.redirect('/');
    } catch (err) {
        console.error(err);
        res.redirect('/');
    }
});

app.get('/admin', async (req, res) => {
    const user = req.session.user;
    if (!user || !ADMIN_IDS.includes(user.id)) return res.status(403).send('Acceso denegado');
    const aspirants = await Aspirant.find().sort({ number: 1 });
    res.render('admin', { aspirants });
});

app.post('/admin/update', async (req, res) => {
    const user = req.session.user;
    if (!user || !ADMIN_IDS.includes(user.id)) return res.status(403).send('Acceso denegado');

    const { discordId, newNumber, action } = req.body;
    if (action === 'delete') {
        await Aspirant.deleteOne({ discordId });
    } else if (newNumber) {
        const existing = await Aspirant.findOne({ number: Number(newNumber) });
        if (!existing) {
            await Aspirant.updateOne({ discordId }, { number: Number(newNumber) });
        }
    }
    res.redirect('/admin');
});

app.get('/api/verify/:discordId', async (req, res) => {
    const aspirant = await Aspirant.findOne({ discordId: req.params.discordId });
    if (!aspirant || aspirant.banned) {
        return res.status(401).json({ allowed: false, message: 'No estás registrado o estás baneado.' });
    }
    res.json({ allowed: true, number: aspirant.number, username: aspirant.username });
});

// Endpoint para que el Launcher verifique al usuario de forma segura
app.post('/api/launcher-login', async (req, res) => {
    const { discordId } = req.body;
    try {
        const aspirant = await Aspirant.findOne({ discordId });
        if (!aspirant || aspirant.banned) {
            return res.json({ success: false, message: 'No estás registrado o estás baneado.' });
        }
        res.json({ 
            success: true, 
            user: { 
                discordId: aspirant.discordId, 
                username: aspirant.username, 
                avatar: aspirant.avatar, 
                number: aspirant.number 
            } 
        });
    } catch (err) {
        res.json({ success: false, message: 'Error interno en el servidor.' });
    }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Web Haunter Eventos corriendo en puerto ${PORT}`));
