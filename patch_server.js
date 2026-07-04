const fs = require('fs');
let s = fs.readFileSync('server.js', 'utf8');

const botUserEndpoint = `
// Bot User Info Route
app.get('/api/v1/bot/user/:discordId', async (req, res) => {
    const authHeader = req.header('Authorization');
    if (!authHeader || authHeader !== \`Bearer \${process.env.INTERNAL_BOT_API_KEY}\`) {
        return res.status(401).json({ error: 'Unauthorized: Invalid internal API key.' });
    }
    try {
        const user = await User.findOne({ discordUserId: req.params.discordId });
        if (!user) {
            return res.status(404).json({ error: 'User not found' });
        }
        res.json({ tier: user.tier, username: user.username });
    } catch (err) {
        console.error('[BOT API] Error fetching user:', err);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// Bot Pull Responses Route
app.get('/api/v1/bot/forms', async (req, res) => {
`;

s = s.replace(/\/\/ Bot Pull Responses Route\s*app\.get\('\/api\/v1\/bot\/forms', async \(req, res\) => \{/, botUserEndpoint);

fs.writeFileSync('server.js', s);
console.log('Patched server.js');
